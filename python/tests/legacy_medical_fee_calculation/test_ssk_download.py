from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from medical_fee_calculation.ssk_download import (
    diff_ssk_master_catalogs,
    discover_ssk_master_catalog,
    download_ssk_master_catalog,
    ssk_master_catalog_diff_to_markdown,
    ssk_master_catalog_discovery_to_markdown,
    ssk_master_catalog_download_to_markdown,
)


class SskDownloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_downloads_catalog_files_and_prepares_standard_manifest(self) -> None:
        root = Path(self.tmp.name)
        raw_root = root / "raw" / "ssk"
        catalog_path = root / "ssk_catalog.json"
        regional_manifest = root / "regional_manifest.json"
        regional_manifest.write_text('{"entries":[]}', encoding="utf-8")
        urls = {
            "https://example.test/s_ALL20260601.zip": _zip_bytes(
                {"s_ALL20260601.csv": b"procedure csv"}
            ),
            "https://example.test/y_ALL20260601.zip": _zip_bytes(
                {"y_ALL20260601.csv": b"drug csv"}
            ),
            "https://example.test/t_ALL20260601.zip": _zip_bytes(
                {"t_ALL20260601.csv": b"material csv"}
            ),
            "https://example.test/ck_ALL_20260601.zip": _zip_bytes(
                {"ck_ALL_20260601.csv": b"comment link csv"}
            ),
            "https://example.test/tensuhyo_20260601.zip": _zip_bytes(
                {
                    "01補助マスターテーブル.csv": b"aux",
                    "02包括テーブル.csv": b"bundle",
                    "03-1背反テーブル1.csv": b"day",
                    "05算定回数テーブル.csv": b"frequency",
                }
            ),
        }
        catalog_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {"kind": "medical_procedure_master", "url": "https://example.test/s_ALL20260601.zip"},
                        {"kind": "drug_master", "url": "https://example.test/y_ALL20260601.zip"},
                        {"kind": "specific_material_master", "url": "https://example.test/t_ALL20260601.zip"},
                        {"kind": "comment_related_table", "url": "https://example.test/ck_ALL_20260601.zip"},
                        {"kind": "medical_electronic_fee_table", "url": "https://example.test/tensuhyo_20260601.zip"},
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        fetched_urls: list[str] = []

        def fetch(url: str) -> bytes:
            fetched_urls.append(url)
            return urls[url]

        result = download_ssk_master_catalog(
            catalog_path,
            raw_root=raw_root,
            source_version="2026-06-01",
            published_at="2026-06-01",
            regional_manifest=regional_manifest,
            fetch_bytes=fetch,
        )
        report = ssk_master_catalog_download_to_markdown(result)
        entries = result.standard_build_manifest["entries"]
        kinds = [entry["kind"] for entry in entries]

        self.assertEqual(fetched_urls, list(urls))
        self.assertEqual([item.status for item in result.items], ["ok", "ok", "ok", "ok", "ok"])
        self.assertTrue(
            (
                raw_root
                / "medical_procedure_master"
                / "2026-06-01"
                / "s_ALL20260601.zip"
            ).exists()
        )
        self.assertTrue(any(path.endswith("s_ALL20260601.csv") for path in result.extracted_files))
        self.assertIn("medical_procedure_master", kinds)
        self.assertIn("drug_master", kinds)
        self.assertIn("specific_material_master", kinds)
        self.assertIn("comment_related_table", kinds)
        self.assertIn("medical_electronic_fee_table", kinds)
        self.assertIn("regional_manifest", kinds)
        self.assertIn("comment_master", result.missing_kinds)
        self.assertIn("Downloaded: 5", report)
        self.assertIn("Manifest entries: 6", report)

    def test_discovers_catalog_from_official_page_like_html(self) -> None:
        pages = {
            "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_01.html": """
                <h2>医科診療行為の全件マスター</h2>
                <p>2026年5月1日</p>
                <a href="kihonmasta_01.files/s_ALL20260501.zip">全件分ファイル</a>
            """,
            "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_04.html": """
                <h2>医薬品の全件マスター</h2>
                <p>2026年3月17日</p>
                <a href="kihonmasta_04.files/y_r07_ALL20260317.zip">全件分ファイル</a>
            """,
            "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_05.html": """
                <h2>特定器材の全件マスター</h2>
                <p>2026年2月27日</p>
                <a href="kihonmasta_05.files/t_ALL20260227.zip">全件分ファイル</a>
            """,
            "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_06.html": """
                <h2>コメントマスターの全件マスター</h2>
                <p>2026年5月7日</p>
                <a href="kihonmasta_06.files/c_ALL20260507.zip">全件分ファイル</a>
                <h2>コメント関連テーブル</h2>
                <p>2026年5月15日</p>
                <a href="kihonmasta_06.files/ck_ALL_20260515.zip">全件分ファイル</a>
            """,
            "https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html": """
                <h2>医科電子点数表</h2>
                <p>令和8年5月1日</p>
                <a href="index.files/tensuhyo_03.zip">医科電子点数表テーブル（令和8年度版）</a>
            """,
        }

        result = discover_ssk_master_catalog(
            fetch_bytes=lambda url: pages[url].encode("utf-8"),
        )
        report = ssk_master_catalog_discovery_to_markdown(result)
        entries = {entry["kind"]: entry for entry in result.catalog["entries"]}

        self.assertEqual(result.page_count, 5)
        self.assertEqual(result.warnings, ())
        self.assertEqual(entries["medical_procedure_master"]["source_version"], "2026-05-01")
        self.assertEqual(entries["drug_master"]["source_version"], "2026-03-17")
        self.assertEqual(entries["specific_material_master"]["source_version"], "2026-02-27")
        self.assertEqual(entries["comment_master"]["source_version"], "2026-05-07")
        self.assertEqual(entries["comment_related_table"]["source_version"], "2026-05-15")
        self.assertEqual(entries["medical_electronic_fee_table"]["source_version"], "2026-05-01")
        self.assertEqual(
            entries["medical_procedure_master"]["url"],
            "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/r06/kihonmasta_01.files/s_ALL20260501.zip",
        )
        self.assertEqual(entries["comment_related_table"]["filename"], "ck_ALL_20260515.zip")
        self.assertIn("Pages fetched: 5", report)

        overridden = discover_ssk_master_catalog(
            source_version="2026-06-01",
            fetch_bytes=lambda url: pages[url].encode("utf-8"),
        )
        overridden_entries = {entry["kind"]: entry for entry in overridden.catalog["entries"]}
        self.assertEqual(overridden_entries["drug_master"]["source_version"], "2026-06-01")
        self.assertEqual(overridden_entries["drug_master"]["published_at"], "2026-03-17")

    def test_diffs_catalogs_by_kind(self) -> None:
        root = Path(self.tmp.name)
        old_catalog = root / "old.json"
        new_catalog = root / "new.json"
        old_catalog.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "medical_procedure_master",
                            "url": "https://example.test/s_ALL20260501.zip",
                            "source_version": "2026-05-01",
                        },
                        {
                            "kind": "drug_master",
                            "url": "https://example.test/y_ALL20260317.zip",
                            "source_version": "2026-03-17",
                        },
                        {
                            "kind": "comment_master",
                            "url": "https://example.test/c_ALL20260507.zip",
                            "source_version": "2026-05-07",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        new_catalog.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "medical_procedure_master",
                            "url": "https://example.test/s_ALL20260601.zip",
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "drug_master",
                            "url": "https://example.test/y_ALL20260317.zip",
                            "source_version": "2026-03-17",
                        },
                        {
                            "kind": "comment_related_table",
                            "url": "https://example.test/ck_ALL_20260601.zip",
                            "source_version": "2026-06-01",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        result = diff_ssk_master_catalogs(old_catalog, new_catalog)
        report = ssk_master_catalog_diff_to_markdown(result)

        self.assertTrue(result.has_changes)
        self.assertEqual([entry["kind"] for entry in result.added], ["comment_related_table"])
        self.assertEqual([entry["kind"] for entry in result.removed], ["comment_master"])
        self.assertEqual([entry["kind"] for entry in result.unchanged], ["drug_master"])
        self.assertEqual([change["kind"] for change in result.changed], ["medical_procedure_master"])
        self.assertEqual(
            result.changed[0]["changed_fields"],
            ["url", "filename", "source_version"],
        )
        self.assertIn("| changed | 1 |", report)


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for filename, data in files.items():
            archive.writestr(filename, data)
    return buffer.getvalue()


if __name__ == "__main__":
    unittest.main()
