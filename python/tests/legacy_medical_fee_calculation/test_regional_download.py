from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.regional_download import (
    download_regional_source_catalog,
    download_regional_source_files_from_page,
    regional_download_batch_to_markdown,
)
from medical_fee_calculation.regional_sources import get_regional_source_page


class RegionalDownloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_downloads_recommended_files_and_builds_manifest(self) -> None:
        page_url = "https://example.test/shitei.html"
        registry_url = "https://example.test/registry-ika.zip"
        raw_root = Path(self.tmp.name) / "raw" / "kouseikyoku"
        html = """
        <table>
          <tr><td>コード内容別医療機関一覧表 医科</td><td><a href="registry-ika.zip">ZIP</a></td></tr>
          <tr><td>コード内容別医療機関一覧表 歯科</td><td><a href="registry-dental.zip">ZIP</a></td></tr>
          <tr><td>医科</td><td><a href="registry-ika.pdf">PDF</a></td></tr>
        </table>
        """
        payloads = {
            page_url: html.encode("utf-8"),
            registry_url: b"registry zip data",
        }
        fetched_urls: list[str] = []

        def fetch(url: str) -> bytes:
            fetched_urls.append(url)
            return payloads[url]

        result = download_regional_source_files_from_page(
            regional_bureau="kinki",
            kind="hospital_registry",
            source_version="2026-05-01",
            raw_root=raw_root,
            page_url=page_url,
            fetch_bytes=fetch,
        )

        expected_path = raw_root / "kinki" / "2026-05-01" / "hospital_registry" / "registry-ika.zip"
        self.assertEqual(fetched_urls, [page_url, registry_url])
        self.assertEqual(result.candidate_count, 3)
        self.assertEqual(result.selected_count, 1)
        self.assertEqual(result.page_path.read_bytes(), html.encode("utf-8"))
        self.assertEqual(expected_path.read_bytes(), b"registry zip data")
        self.assertEqual(result.downloaded_files[0].path, expected_path)
        self.assertEqual(result.downloaded_files[0].size_bytes, len(b"registry zip data"))
        self.assertEqual(
            result.downloaded_files[0].checksum_sha256,
            hashlib.sha256(b"registry zip data").hexdigest(),
        )
        self.assertEqual(
            result.manifest["entries"],
            [
                {
                    "kind": "hospital_registry",
                    "regional_bureau": "kinki",
                    "path": str(expected_path),
                    "source_version": "2026-05-01",
                    "url": registry_url,
                }
            ],
        )

    def test_downloads_catalog_subset_and_reports_failures(self) -> None:
        raw_root = Path(self.tmp.name) / "raw" / "kouseikyoku"
        hospital_page = get_regional_source_page("kinki", "hospital_registry")
        facility_page = get_regional_source_page("kinki", "facility_standards")
        registry_url = "https://kouseikyoku.mhlw.go.jp/kinki/tyousa/registry-ika.zip"
        html = """
        <table>
          <tr><td>コード内容別医療機関一覧表 医科</td><td><a href="registry-ika.zip">ZIP</a></td></tr>
        </table>
        """

        def fetch(url: str) -> bytes:
            if url == hospital_page.url:
                return html.encode("utf-8")
            if url == registry_url:
                return b"registry zip data"
            if url == facility_page.url:
                raise RuntimeError("fixture failure")
            raise AssertionError(f"unexpected URL: {url}")

        result = download_regional_source_catalog(
            source_version="2026-05-01",
            raw_root=raw_root,
            regional_bureaus=("kinki",),
            fetch_bytes=fetch,
        )
        report = regional_download_batch_to_markdown(result)

        self.assertEqual([item.status for item in result.items], ["ok", "failed"])
        self.assertEqual(result.manifest["entries"][0]["url"], registry_url)
        self.assertIn("fixture failure", result.items[1].error or "")
        self.assertIn("Failed: 1", report)
        self.assertIn("Manifest entries: 1", report)


if __name__ == "__main__":
    unittest.main()
