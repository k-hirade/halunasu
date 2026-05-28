from __future__ import annotations

from dataclasses import dataclass


REGIONAL_SOURCE_KINDS = frozenset(("hospital_registry", "facility_standards"))


@dataclass(frozen=True)
class RegionalSourcePage:
    regional_bureau: str
    kind: str
    url: str
    expected_publication: str
    importer_status: str
    notes: str


REGIONAL_SOURCE_PAGES: tuple[RegionalSourcePage, ...] = (
    RegionalSourcePage(
        regional_bureau="hokkaido",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/code_ichiran.html",
        expected_publication="separate medical hospital/clinic xlsx files",
        importer_status="supported",
        notes="Hospital and clinic files are separate. The hospital layout has been smoke-tested.",
    ),
    RegionalSourcePage(
        regional_bureau="hokkaido",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/hokkaido/gyomu/gyomu/hoken_kikan/todokede_juri_ichiran.html",
        expected_publication="medical facility standards xlsx file",
        importer_status="supported",
        notes="The 24-column layout has been smoke-tested.",
    ),
    RegionalSourcePage(
        regional_bureau="tohoku",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/tohoku/gyomu/gyomu/hoken_kikan/itiran.html",
        expected_publication="medical xlsx file",
        importer_status="needs_official_file_smoke",
        notes="The generic importer can load it if the workbook layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="tohoku",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/tohoku/gyomu/gyomu/hoken_kikan/documents/201805koushin.html",
        expected_publication="six-prefecture xlsx files by facility-standard group",
        importer_status="needs_layout_adapter",
        notes="Separate whole-list files from facility-standard-group files before import.",
    ),
    RegionalSourcePage(
        regional_bureau="kanto_shinetsu",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/kantoshinetsu/chousa/shitei.html",
        expected_publication="prefecture-level PDF files, possible xlsx/zip variation",
        importer_status="needs_pdf_or_excel_discovery",
        notes="Monthly discovery must distinguish xlsx/zip availability from PDF-only files.",
    ),
    RegionalSourcePage(
        regional_bureau="kanto_shinetsu",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/kantoshinetsu/chousa/kijyun.html",
        expected_publication="facility standards accepted-list files",
        importer_status="needs_official_file_smoke",
        notes="Whole-list files and recent-acceptance files must be handled separately.",
    ),
    RegionalSourcePage(
        regional_bureau="tokai_hokuriku",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/tokaihokuriku/newpage_00287.html",
        expected_publication="prefecture-level PDF files, possible xlsx/zip variation",
        importer_status="needs_pdf_or_excel_discovery",
        notes="Monthly discovery must check whether xlsx files are published.",
    ),
    RegionalSourcePage(
        regional_bureau="tokai_hokuriku",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/tokaihokuriku/newpage_00349.html",
        expected_publication="medical facility standards zip file",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the 24-column layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="kinki",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/kinki/tyousa/shinkishitei.html",
        expected_publication="prefecture-level xlsx files in a zip archive",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the workbook layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="kinki",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/kinki/gyomu/gyomu/hoken_kikan/shitei_jokyo_00004.html",
        expected_publication="facility standards accepted-list zip file",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the 24-column layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="chugoku_shikoku",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/chugokushikoku/chousaka/iryoukikanshitei.html",
        expected_publication="five-prefecture xlsx files in a zip archive",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the workbook layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="chugoku_shikoku",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/chugokushikoku/chousaka/shisetsukijunjuri.html",
        expected_publication="whole accepted-list and major facility-standard-group files",
        importer_status="needs_layout_adapter",
        notes="Whole-list files and major-group files need separate import semantics.",
    ),
    RegionalSourcePage(
        regional_bureau="shikoku",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/hoken_kikan/shitei/index.html",
        expected_publication="four-prefecture xlsx files in a zip archive",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the workbook layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="shikoku",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/shikoku/gyomu/gyomu/hoken_kikan/shitei/index.html",
        expected_publication="whole accepted-list zip plus facility-standard-group zips",
        importer_status="needs_official_file_smoke",
        notes="Prefer the whole-list zip; use group-level files as supporting ward/facility evidence.",
    ),
    RegionalSourcePage(
        regional_bureau="kyushu",
        kind="hospital_registry",
        url="https://kouseikyoku.mhlw.go.jp/kyushu/gyomu/gyomu/hoken_kikan/index_00006.html",
        expected_publication="prefecture-level xlsx files in zip archives",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the workbook layout matches.",
    ),
    RegionalSourcePage(
        regional_bureau="kyushu",
        kind="facility_standards",
        url="https://kouseikyoku.mhlw.go.jp/kyushu/gyomu/gyomu/hoken_kikan/index_00007.html",
        expected_publication="prefecture-level xlsx files in zip archives",
        importer_status="needs_official_file_smoke",
        notes="The generic zip importer can load it if the 24-column layout matches.",
    ),
)


def list_regional_source_pages(kind: str | None = None) -> tuple[RegionalSourcePage, ...]:
    if kind is None:
        return REGIONAL_SOURCE_PAGES
    if kind not in REGIONAL_SOURCE_KINDS:
        raise ValueError(f"unsupported source kind: {kind}")
    return tuple(page for page in REGIONAL_SOURCE_PAGES if page.kind == kind)


def get_regional_source_page(regional_bureau: str, kind: str) -> RegionalSourcePage:
    for page in REGIONAL_SOURCE_PAGES:
        if page.regional_bureau == regional_bureau and page.kind == kind:
            return page
    raise ValueError(f"unsupported regional source page: {regional_bureau} {kind}")
