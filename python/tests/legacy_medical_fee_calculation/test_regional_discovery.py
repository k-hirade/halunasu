from __future__ import annotations

import unittest

from medical_fee_calculation.regional_discovery import (
    build_manifest_template,
    discover_regional_source_files,
    select_regional_source_file_candidates,
)
from medical_fee_calculation.regional_sources import get_regional_source_page


class RegionalDiscoveryTest(unittest.TestCase):
    def test_discovers_download_links_from_saved_html(self) -> None:
        source_page = get_regional_source_page("shikoku", "facility_standards")
        html = """
        <html>
          <body>
            <a href="documents/facility.zip">prefecture xlsx data zip</a>
            <a href="/shikoku/documents/facility.pdf">medical pdf</a>
            <a href="documents/facility.zip">duplicate zip</a>
            <a href="documents/readme.txt">ignore text</a>
          </body>
        </html>
        """

        candidates = discover_regional_source_files(
            html,
            page_url=source_page.url,
            regional_bureau=source_page.regional_bureau,
            kind=source_page.kind,
        )

        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0].extension, ".zip")
        self.assertEqual(candidates[0].context, "")
        self.assertTrue(candidates[0].is_importable)
        self.assertEqual(candidates[0].regional_bureau, "shikoku")
        self.assertEqual(candidates[0].kind, "facility_standards")
        self.assertEqual(
            candidates[0].url,
            "https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/hoken_kikan/shitei/documents/facility.zip",
        )
        self.assertEqual(candidates[1].extension, ".pdf")
        self.assertFalse(candidates[1].is_importable)

        manifest = build_manifest_template(
            candidates,
            source_version="2026-05-01",
            raw_root="data/raw/kouseikyoku",
            published_at="2026-05-10",
        )
        self.assertEqual(
            manifest,
            {
                "entries": [
                    {
                        "kind": "facility_standards",
                        "regional_bureau": "shikoku",
                        "path": "data/raw/kouseikyoku/shikoku/2026-05-01/facility_standards/facility.zip",
                        "source_version": "2026-05-01",
                        "url": (
                            "https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/"
                            "hoken_kikan/shitei/documents/facility.zip"
                        ),
                        "published_at": "2026-05-10",
                    }
                ]
            },
        )

    def test_discovers_uppercase_workbook_extension(self) -> None:
        candidates = discover_regional_source_files(
            '<a href="download/registry.XLSX?download=1"> workbook </a>',
            page_url="https://example.test/base/index.html",
            regional_bureau="tohoku",
            kind="hospital_registry",
        )

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].extension, ".xlsx")
        self.assertEqual(candidates[0].label, "workbook")
        self.assertTrue(candidates[0].is_importable)

    def test_selects_medical_whole_list_before_other_links(self) -> None:
        html = """
        <table>
          <tr><td>歯科</td><td><a href="dental.zip">ZIP</a></td></tr>
          <tr><td>薬局</td><td><a href="pharmacy.zip">ZIP</a></td></tr>
          <tr><td>届出受理医療機関名簿（全体） 医科</td><td><a href="ika-whole.zip">ZIP</a></td></tr>
          <tr><td>施設基準の受理状況（直近届出分） 医科</td><td><a href="ika-recent.zip">ZIP</a></td></tr>
          <tr><td>医科</td><td><a href="ika.pdf">PDF</a></td></tr>
        </table>
        """

        candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/kijyun.html",
            regional_bureau="kanto_shinetsu",
            kind="facility_standards",
        )
        selected = select_regional_source_file_candidates(candidates)

        self.assertGreater(len(selected), 0)
        self.assertEqual(selected[0].url, "https://example.test/ika-whole.zip")
        self.assertNotIn("https://example.test/dental.zip", {candidate.url for candidate in selected})
        self.assertNotIn("https://example.test/pharmacy.zip", {candidate.url for candidate in selected})
        self.assertNotIn("https://example.test/ika.pdf", {candidate.url for candidate in selected})

        manifest = build_manifest_template(
            candidates,
            source_version="2026-05-01",
            raw_root="data/raw/kouseikyoku",
            recommended_only=True,
        )
        self.assertEqual(manifest["entries"][0]["url"], "https://example.test/ika-whole.zip")

    def test_selects_hospital_registry_code_list_before_new_designations(self) -> None:
        html = """
        <table>
          <tr><td>保険医療機関・保険薬局の新規指定一覧 医科</td><td><a href="new-ika.zip">ZIP</a></td></tr>
          <tr><td>コード内容別医療機関一覧表 医科</td><td><a href="registry-ika.zip">ZIP</a></td></tr>
          <tr><td>コード内容別医療機関一覧表 歯科</td><td><a href="registry-dental.zip">ZIP</a></td></tr>
        </table>
        """

        candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/shitei.html",
            regional_bureau="kinki",
            kind="hospital_registry",
        )
        selected = select_regional_source_file_candidates(candidates)

        self.assertEqual(selected[0].url, "https://example.test/registry-ika.zip")

    def test_selects_hospital_registry_hospital_file_without_clinic_split(self) -> None:
        html = """
        <table>
          <tr><th>医科（病院）</th><td><a href="hospital.xlsx">Excel</a></td></tr>
          <tr><th>医科（診療所）</th><td><a href="clinic.xlsx">Excel</a></td></tr>
        </table>
        """

        candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/code.html",
            regional_bureau="hokkaido",
            kind="hospital_registry",
        )
        selected = select_regional_source_file_candidates(candidates)

        self.assertEqual([candidate.url for candidate in selected], ["https://example.test/hospital.xlsx"])

    def test_uses_section_headings_to_separate_registry_and_facility_files(self) -> None:
        html = """
        <h5>1.保険医療機関・保険薬局の指定一覧（全体）</h5>
        <table>
          <tr><th>医 科</th><td><a href="registry-medical.zip">ZIP</a></td></tr>
          <tr><th>歯 科</th><td><a href="registry-dental.zip">ZIP</a></td></tr>
        </table>
        <h5>4.施設基準の届出受理状況（全体）</h5>
        <table>
          <tr><th>医 科</th><td><a href="facility-medical.zip">ZIP</a></td></tr>
          <tr><th>薬 局</th><td><a href="facility-pharmacy.zip">ZIP</a></td></tr>
        </table>
        <h5>7.施設基準の届出受理状況（主な届出項目別）</h5>
        <table>
          <tr><th>救命救急入院料</th><td><a href="facility-group.zip">ZIP</a></td></tr>
        </table>
        """

        registry_candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/index.html",
            regional_bureau="shikoku",
            kind="hospital_registry",
        )
        facility_candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/index.html",
            regional_bureau="shikoku",
            kind="facility_standards",
        )

        registry_selected = select_regional_source_file_candidates(registry_candidates)
        facility_selected = select_regional_source_file_candidates(facility_candidates)

        self.assertEqual([candidate.url for candidate in registry_selected], ["https://example.test/registry-medical.zip"])
        self.assertEqual([candidate.url for candidate in facility_selected], ["https://example.test/facility-medical.zip"])

    def test_selects_inpatient_facility_supplements(self) -> None:
        html = """
        <h5>施設基準の届出受理状況（全体）</h5>
        <p>令和8年5月1日現在 医科</p>
        <a href="2026.5_sisetukijun_ika.zip">（ZIP）</a>
        <h5>施設基準の届出受理状況（届出項目別：入院基本料・特定入院料）</h5>
        <p>令和8年5月1日現在 入院基本料</p>
        <a href="2026.5_nyuuin.xlsx">（Excel）</a>
        <p>令和8年5月1日現在 特定入院料</p>
        <a href="2026.5_tokutei.xlsx">（Excel）</a>
        <h5>保険外併用療養費の報告状況</h5>
        <p>令和8年5月1日現在 医科</p>
        <a href="2026.5_hokengai_ika.xlsx">（Excel）</a>
        """

        candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/kijyun.html",
            regional_bureau="kinki",
            kind="facility_standards",
        )
        selected = select_regional_source_file_candidates(candidates)

        self.assertEqual(
            {candidate.url for candidate in selected},
            {
                "https://example.test/2026.5_sisetukijun_ika.zip",
                "https://example.test/2026.5_nyuuin.xlsx",
                "https://example.test/2026.5_tokutei.xlsx",
            },
        )
        self.assertNotIn("https://example.test/2026.5_hokengai_ika.xlsx", {candidate.url for candidate in selected})

    def test_keeps_undated_inpatient_facility_supplements_with_latest_main_file(self) -> None:
        html = """
        <h5>施設基準の届出状況（全体）</h5>
        <p>令和8年4月1日現在 各都県分 エクセルデータ</p>
        <a href="shisetsu_ika_r0805.zip">医科（ZIP）</a>
        <h5>届出項目別1（入院基本料等）</h5>
        <p>各都県分エクセルデータ</p>
        <a href="koumokubetsu1_r0805.zip">届出項目別1（ZIP）</a>
        <h5>届出項目別2（特定入院料）</h5>
        <p>各都県分エクセルデータ</p>
        <a href="koumokubetsu2_r0805.zip">届出項目別2（ZIP）</a>
        """

        candidates = discover_regional_source_files(
            html,
            page_url="https://example.test/kijyun.html",
            regional_bureau="kanto_shinetsu",
            kind="facility_standards",
        )
        selected = select_regional_source_file_candidates(candidates)

        self.assertEqual(
            {candidate.url for candidate in selected},
            {
                "https://example.test/shisetsu_ika_r0805.zip",
                "https://example.test/koumokubetsu1_r0805.zip",
                "https://example.test/koumokubetsu2_r0805.zip",
            },
        )


if __name__ == "__main__":
    unittest.main()
