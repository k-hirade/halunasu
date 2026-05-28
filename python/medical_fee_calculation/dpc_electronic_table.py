from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from medical_fee_calculation.importers import ImportResult, _compact_date, _upsert_source, sha256_file
from medical_fee_calculation.xlsx_reader import XlsxSheetRef, read_all_sheet_rows


DPC_ELECTRONIC_TABLE_SOURCE_TYPE = "dpc_electronic_table"

REQUIRED_DPC_SHEET_PURPOSES = frozenset(
    (
        "dpc_point_table",
        "icd",
        "surgery",
        "surgery_procedure_1",
        "surgery_procedure_2",
        "defined_comorbidities",
        "conversion_table",
        "piecework_surgery_codes",
    )
)


@dataclass(frozen=True)
class DpcElectronicTableSheetInventory:
    sheet_index: int
    sheet_id: str
    sheet_name: str
    sheet_path: str
    purpose: str
    row_count: int
    non_empty_row_count: int
    max_column_count: int
    header_row_index: int | None
    header_values: tuple[str, ...]
    sample_rows: tuple[tuple[str, ...], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "sheet_index": self.sheet_index,
            "sheet_id": self.sheet_id,
            "sheet_name": self.sheet_name,
            "sheet_path": self.sheet_path,
            "purpose": self.purpose,
            "row_count": self.row_count,
            "non_empty_row_count": self.non_empty_row_count,
            "max_column_count": self.max_column_count,
            "header_row_index": self.header_row_index,
            "header_values": list(self.header_values),
            "sample_rows": [list(row) for row in self.sample_rows],
        }


@dataclass(frozen=True)
class DpcElectronicTableWorkbookInventory:
    path: str
    file_name: str
    checksum_sha256: str
    source_id: str | None
    source_url: str | None
    source_version: str | None
    published_at: str | None
    retrieved_at: str | None
    sheet_count: int
    required_sheet_purposes: tuple[str, ...]
    missing_required_sheet_purposes: tuple[str, ...]
    sheets: tuple[DpcElectronicTableSheetInventory, ...]

    @property
    def ready_for_raw_import(self) -> bool:
        return not self.missing_required_sheet_purposes

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "file_name": self.file_name,
            "checksum_sha256": self.checksum_sha256,
            "source_id": self.source_id,
            "source_url": self.source_url,
            "source_version": self.source_version,
            "published_at": self.published_at,
            "retrieved_at": self.retrieved_at,
            "sheet_count": self.sheet_count,
            "required_sheet_purposes": list(self.required_sheet_purposes),
            "missing_required_sheet_purposes": list(self.missing_required_sheet_purposes),
            "ready_for_raw_import": self.ready_for_raw_import,
            "sheets": [sheet.to_dict() for sheet in self.sheets],
        }


@dataclass(frozen=True)
class DpcElectronicTableInventoryBatch:
    source_version: str | None
    workbooks: tuple[DpcElectronicTableWorkbookInventory, ...]

    @property
    def ready_for_raw_import(self) -> bool:
        return bool(self.workbooks) and all(
            workbook.ready_for_raw_import for workbook in self.workbooks
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "inventory_version": "dpc_electronic_table_inventory.v1",
            "source_version": self.source_version,
            "ready_for_raw_import": self.ready_for_raw_import,
            "workbook_count": len(self.workbooks),
            "workbooks": [workbook.to_dict() for workbook in self.workbooks],
        }


def build_dpc_electronic_table_inventory(
    path: str | Path,
    *,
    source_id: str | None = None,
    source_url: str | None = None,
    source_version: str | None = None,
    published_at: str | None = None,
    retrieved_at: str | None = None,
) -> DpcElectronicTableWorkbookInventory:
    workbook_path = Path(path)
    sheet_rows = read_all_sheet_rows(workbook_path)
    sheets = tuple(
        _sheet_inventory(index, sheet_ref, rows)
        for index, (sheet_ref, rows) in enumerate(sheet_rows, start=1)
    )
    purposes = {sheet.purpose for sheet in sheets}
    missing = tuple(sorted(REQUIRED_DPC_SHEET_PURPOSES - purposes))
    return DpcElectronicTableWorkbookInventory(
        path=str(workbook_path),
        file_name=workbook_path.name,
        checksum_sha256=sha256_file(workbook_path),
        source_id=source_id,
        source_url=source_url,
        source_version=source_version,
        published_at=published_at,
        retrieved_at=retrieved_at,
        sheet_count=len(sheets),
        required_sheet_purposes=tuple(sorted(REQUIRED_DPC_SHEET_PURPOSES)),
        missing_required_sheet_purposes=missing,
        sheets=sheets,
    )


def build_dpc_electronic_table_inventory_batch(
    paths: list[str | Path],
    *,
    source_version: str | None = None,
) -> DpcElectronicTableInventoryBatch:
    workbooks = tuple(
        build_dpc_electronic_table_inventory(path, source_version=source_version)
        for path in paths
    )
    return DpcElectronicTableInventoryBatch(
        source_version=source_version,
        workbooks=workbooks,
    )


def build_dpc_electronic_table_inventory_batch_from_catalog(
    catalog_path: str | Path,
    raw_root: str | Path,
) -> DpcElectronicTableInventoryBatch:
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    source_version = _optional_text(catalog.get("source_version"))
    retrieved_at = _optional_text(catalog.get("retrieved_at"))
    entries = [
        entry
        for entry in catalog.get("entries", [])
        if isinstance(entry, dict)
        and entry.get("category") == "dpc_electronic_fee_table"
        and entry.get("file_type") == "xlsx"
    ]

    workbooks: list[DpcElectronicTableWorkbookInventory] = []
    for entry in entries:
        url = _optional_text(entry.get("url"))
        if url is None:
            continue
        file_name = Path(urlparse(url).path).name
        workbooks.append(
            build_dpc_electronic_table_inventory(
                Path(raw_root) / file_name,
                source_id=_optional_text(entry.get("id")),
                source_url=url,
                source_version=source_version,
                published_at=_optional_text(entry.get("published_at")),
                retrieved_at=retrieved_at,
            )
        )

    return DpcElectronicTableInventoryBatch(
        source_version=source_version,
        workbooks=tuple(workbooks),
    )


def import_dpc_electronic_table(
    conn: sqlite3.Connection,
    xlsx_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    retrieved_at: str | None = None,
) -> ImportResult:
    path = Path(xlsx_path)
    sheet_rows = read_all_sheet_rows(path)
    row_count = sum(1 for _, rows in sheet_rows for row in rows if _has_value(row))
    checksum = sha256_file(path)
    source_id = _upsert_source(
        conn,
        source_type=DPC_ELECTRONIC_TABLE_SOURCE_TYPE,
        source_version=source_version,
        raw_path=str(path),
        checksum_sha256=checksum,
        row_count=row_count,
        published_at=published_at,
        url=url,
        encoding="xlsx",
        retrieved_at=retrieved_at,
        replace_tables=(
            "dpc_electronic_table_rows",
            "dpc_point_table",
            "dpc_conversion_table",
            "dpc_icd_table",
            "dpc_surgery_table",
            "dpc_piecework_surgery_codes",
        ),
    )

    rows_to_insert: list[tuple[object, ...]] = []
    point_rows_to_insert: list[tuple[object, ...]] = []
    conversion_rows_to_insert: list[tuple[object, ...]] = []
    icd_rows_to_insert: list[tuple[object, ...]] = []
    surgery_rows_to_insert: list[tuple[object, ...]] = []
    piecework_rows_to_insert: list[tuple[object, ...]] = []
    for sheet_index, (sheet_ref, rows) in enumerate(sheet_rows, start=1):
        purpose = classify_dpc_sheet_purpose(sheet_ref.name)
        for row_index, row in enumerate(rows, start=1):
            if not _has_value(row):
                continue
            rows_to_insert.append(
                (
                    source_id,
                    path.name,
                    sheet_ref.name,
                    sheet_index,
                    purpose,
                    row_index,
                    json.dumps(row, ensure_ascii=False, separators=(",", ":")),
                )
            )
            if purpose == "dpc_point_table":
                normalized = _dpc_point_table_record(source_id, path.name, row_index, row)
                if normalized is not None:
                    point_rows_to_insert.append(normalized)
            elif purpose == "conversion_table":
                normalized = _dpc_conversion_table_record(source_id, path.name, row_index, row)
                if normalized is not None:
                    conversion_rows_to_insert.append(normalized)
            elif purpose == "icd":
                normalized = _dpc_icd_table_record(source_id, path.name, row_index, row)
                if normalized is not None:
                    icd_rows_to_insert.append(normalized)
            elif purpose == "surgery":
                normalized = _dpc_surgery_table_record(source_id, path.name, row_index, row)
                if normalized is not None:
                    surgery_rows_to_insert.append(normalized)
            elif purpose == "piecework_surgery_codes":
                normalized = _dpc_piecework_surgery_code_record(source_id, path.name, row_index, row)
                if normalized is not None:
                    piecework_rows_to_insert.append(normalized)

    conn.executemany(
        """
        INSERT INTO dpc_electronic_table_rows (
            source_id,
            workbook_file,
            sheet_name,
            sheet_index,
            sheet_purpose,
            row_index,
            row_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows_to_insert,
    )
    conn.executemany(
        """
        INSERT INTO dpc_point_table (
            source_id,
            workbook_file,
            row_index,
            serial_number,
            dpc_code,
            diagnosis_name,
            surgery_name,
            surgery_procedure_1,
            surgery_procedure_2,
            defined_comorbidity,
            severity,
            period_1_days,
            period_2_days,
            period_3_days,
            period_1_points,
            period_2_points,
            period_3_points,
            change_category,
            effective_from,
            effective_to,
            updated_at,
            raw_row_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        point_rows_to_insert,
    )
    conn.executemany(
        """
        INSERT INTO dpc_conversion_table (
            source_id,
            workbook_file,
            row_index,
            serial_number,
            dpc_code,
            inclusive_payment_flag,
            mdc_code,
            classification_code,
            disease_state_classification,
            age_condition,
            month_age_condition,
            weight_condition,
            jcs_condition,
            burn_index_condition,
            gaf_condition,
            pregnancy_weeks_condition,
            delivery_bleeding_amount_condition,
            surgery_flag,
            surgery_procedure_1_flag,
            surgery_procedure_2_flag,
            defined_comorbidity_flag,
            severity_age_condition,
            severity_jcs_condition,
            unilateral_bilateral_condition,
            first_reoperation_condition,
            one_eye_both_eyes_condition,
            one_side_both_sides_condition,
            rehabilitation_condition,
            mild_severe_condition,
            pre_onset_rankin_scale_condition,
            a_drop_score_condition,
            transfer_from_other_hospital_ward_condition,
            stroke_onset_timing_condition,
            child_pugh_classification_condition,
            change_category,
            effective_from,
            effective_to,
            updated_at,
            raw_row_json
        )
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        conversion_rows_to_insert,
    )
    conn.executemany(
        """
        INSERT INTO dpc_icd_table (
            source_id,
            workbook_file,
            row_index,
            mdc_code,
            classification_code,
            icd_name,
            icd_code,
            change_category,
            effective_from,
            effective_to,
            updated_at,
            raw_row_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        icd_rows_to_insert,
    )
    conn.executemany(
        """
        INSERT INTO dpc_surgery_table (
            source_id,
            workbook_file,
            row_index,
            mdc_code,
            classification_code,
            value_code,
            surgery_flag,
            age_birthweight_value,
            corresponding_code,
            surgery_1_name,
            surgery_1_code,
            surgery_2_name,
            surgery_2_code,
            surgery_3_name,
            surgery_3_code,
            surgery_4_name,
            surgery_4_code,
            surgery_5_name,
            surgery_5_code,
            change_category,
            effective_from,
            effective_to,
            updated_at,
            raw_row_json
        )
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        surgery_rows_to_insert,
    )
    conn.executemany(
        """
        INSERT INTO dpc_piecework_surgery_codes (
            source_id,
            workbook_file,
            row_index,
            category_code,
            surgery_code,
            surgery_name,
            change_category,
            effective_from,
            effective_to,
            updated_at,
            raw_row_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        piecework_rows_to_insert,
    )
    conn.commit()
    return ImportResult(source_id=source_id, row_count=row_count, checksum_sha256=checksum)


def dpc_electronic_table_inventory_to_markdown(
    batch: DpcElectronicTableInventoryBatch,
) -> str:
    lines = [
        "# DPC Electronic Table Inventory",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| Source version | {batch.source_version or ''} |",
        f"| Ready for raw import | {'yes' if batch.ready_for_raw_import else 'no'} |",
        f"| Workbooks | {len(batch.workbooks)} |",
    ]

    for workbook in batch.workbooks:
        lines.extend(
            (
                "",
                f"## {workbook.file_name}",
                "",
                "| Field | Value |",
                "| --- | --- |",
                f"| Source ID | {_escape_markdown_table_cell(workbook.source_id or '')} |",
                f"| Source URL | {_escape_markdown_table_cell(workbook.source_url or '')} |",
                f"| Published at | {workbook.published_at or ''} |",
                f"| Retrieved at | {workbook.retrieved_at or ''} |",
                f"| SHA-256 | `{workbook.checksum_sha256}` |",
                f"| Sheets | {workbook.sheet_count} |",
                f"| Ready for raw import | {'yes' if workbook.ready_for_raw_import else 'no'} |",
                f"| Missing required purposes | {_escape_markdown_table_cell(', '.join(workbook.missing_required_sheet_purposes))} |",
                "",
                "| # | Sheet | Purpose | Rows | Non-empty | Max columns | Header row | Header sample |",
                "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
            )
        )
        for sheet in workbook.sheets:
            lines.append(
                "| "
                + " | ".join(
                    (
                        str(sheet.sheet_index),
                        _escape_markdown_table_cell(sheet.sheet_name),
                        sheet.purpose,
                        str(sheet.row_count),
                        str(sheet.non_empty_row_count),
                        str(sheet.max_column_count),
                        "" if sheet.header_row_index is None else str(sheet.header_row_index),
                        _escape_markdown_table_cell(" / ".join(sheet.header_values[:8])),
                    )
                )
                + " |"
            )
    return "\n".join(lines)


def dpc_electronic_table_inventory_to_tsv(
    batch: DpcElectronicTableInventoryBatch,
) -> str:
    lines = [
        "file_name\tsource_id\tsheet_index\tsheet_name\tpurpose\trow_count\t"
        "non_empty_row_count\tmax_column_count\theader_row_index\theader_values"
    ]
    for workbook in batch.workbooks:
        for sheet in workbook.sheets:
            lines.append(
                "\t".join(
                    (
                        workbook.file_name,
                        workbook.source_id or "",
                        str(sheet.sheet_index),
                        sheet.sheet_name.replace("\t", " "),
                        sheet.purpose,
                        str(sheet.row_count),
                        str(sheet.non_empty_row_count),
                        str(sheet.max_column_count),
                        "" if sheet.header_row_index is None else str(sheet.header_row_index),
                        " / ".join(sheet.header_values).replace("\t", " "),
                    )
                )
            )
    return "\n".join(lines)


def classify_dpc_sheet_purpose(sheet_name: str) -> str:
    compact = sheet_name.replace(" ", "").replace("　", "")
    if "修正箇所" in compact:
        return "corrections"
    if "前提条件" in compact:
        return "prerequisites"
    if "ダミーコード" in compact:
        return "dummy_codes"
    if "ＭＤＣ名称" in compact or "MDC名称" in compact:
        return "mdc_names"
    if "分類名称" in compact:
        return "classification_names"
    if "病態等分類" in compact:
        return "disease_state_classifications"
    if "ＩＣＤ" in compact or "ICD" in compact:
        return "icd"
    if "年齢" in compact or "出生時体重" in compact:
        return "age_birthweight_conditions"
    if "手術・処置等１" in compact:
        return "surgery_procedure_1"
    if "手術・処置等２" in compact:
        return "surgery_procedure_2"
    if "出来高算定手術等コード" in compact:
        return "piecework_surgery_codes"
    if "重症度等" in compact:
        return "severity_conditions"
    if "手術" in compact:
        return "surgery"
    if "定義副傷病名" in compact:
        return "defined_comorbidities"
    if "診断群分類点数表" in compact:
        return "dpc_point_table"
    if "変換テーブル" in compact:
        return "conversion_table"
    if "CCPM" in compact:
        return "ccpm_mapping"
    return "unknown"


def _sheet_inventory(
    sheet_index: int,
    sheet_ref: XlsxSheetRef,
    rows: list[list[str]],
) -> DpcElectronicTableSheetInventory:
    non_empty_rows = [(index, row) for index, row in enumerate(rows, start=1) if _has_value(row)]
    header_row_index, header_values = _detect_header(non_empty_rows)
    return DpcElectronicTableSheetInventory(
        sheet_index=sheet_index,
        sheet_id=sheet_ref.sheet_id,
        sheet_name=sheet_ref.name,
        sheet_path=sheet_ref.path,
        purpose=classify_dpc_sheet_purpose(sheet_ref.name),
        row_count=len(rows),
        non_empty_row_count=len(non_empty_rows),
        max_column_count=max((len(row) for row in rows), default=0),
        header_row_index=header_row_index,
        header_values=tuple(header_values[:20]),
        sample_rows=tuple(tuple(_trim_row(row)[:20]) for _, row in non_empty_rows[:5]),
    )


def _detect_header(non_empty_rows: list[tuple[int, list[str]]]) -> tuple[int | None, list[str]]:
    for row_index, row in non_empty_rows[:20]:
        trimmed = _trim_row(row)
        non_empty_count = sum(1 for value in trimmed if value)
        has_text = any(_has_japanese_or_alpha(value) for value in trimmed)
        if non_empty_count >= 2 and has_text:
            return row_index, trimmed
    if non_empty_rows:
        row_index, row = non_empty_rows[0]
        return row_index, _trim_row(row)
    return None, []


def _dpc_point_table_record(
    source_id: int,
    workbook_file: str,
    row_index: int,
    row: list[str],
) -> tuple[object, ...] | None:
    dpc_code = _cell(row, 2)
    if not _looks_like_dpc_code(dpc_code):
        return None
    return (
        source_id,
        workbook_file,
        row_index,
        _cell(row, 1),
        dpc_code,
        _cell(row, 3),
        _cell(row, 4),
        _cell(row, 5),
        _cell(row, 6),
        _cell(row, 7),
        _cell(row, 8),
        _int_value(_cell(row, 9)),
        _int_value(_cell(row, 10)),
        _int_value(_cell(row, 11)),
        _int_value(_cell(row, 12)),
        _int_value(_cell(row, 13)),
        _int_value(_cell(row, 14)),
        _cell(row, 15),
        _compact_date(_cell(row, 16)),
        _compact_date(_cell(row, 17)),
        _compact_date(_cell(row, 18)),
        _json_row(row),
    )


def _dpc_conversion_table_record(
    source_id: int,
    workbook_file: str,
    row_index: int,
    row: list[str],
) -> tuple[object, ...] | None:
    dpc_code = _cell(row, 1)
    if not _looks_like_dpc_code(dpc_code):
        return None
    return (
        source_id,
        workbook_file,
        row_index,
        _cell(row, 0),
        dpc_code,
        _cell(row, 2),
        _cell(row, 3),
        _cell(row, 4),
        _cell(row, 5),
        _cell(row, 6),
        _cell(row, 7),
        _cell(row, 8),
        _cell(row, 9),
        _cell(row, 10),
        _cell(row, 11),
        _cell(row, 12),
        _cell(row, 13),
        _cell(row, 14),
        _cell(row, 15),
        _cell(row, 16),
        _cell(row, 17),
        _cell(row, 18),
        _cell(row, 19),
        _cell(row, 20),
        _cell(row, 21),
        _cell(row, 22),
        _cell(row, 23),
        _cell(row, 24),
        _cell(row, 25),
        _cell(row, 26),
        _cell(row, 27),
        _cell(row, 28),
        _cell(row, 29),
        _cell(row, 30),
        _cell(row, 31),
        _compact_date(_cell(row, 32)),
        _compact_date(_cell(row, 33)),
        _compact_date(_cell(row, 34)),
        _json_row(row),
    )


def _dpc_icd_table_record(
    source_id: int,
    workbook_file: str,
    row_index: int,
    row: list[str],
) -> tuple[object, ...] | None:
    mdc_code = _cell(row, 0)
    classification_code = _cell(row, 1)
    icd_code = _cell(row, 3)
    if not _looks_like_mdc_code(mdc_code) or not _looks_like_classification_code(
        classification_code
    ):
        return None
    if not icd_code or icd_code.lower() == "icdコード":
        return None
    return (
        source_id,
        workbook_file,
        row_index,
        mdc_code,
        classification_code,
        _cell(row, 2),
        icd_code,
        _cell(row, 4),
        _compact_date(_cell(row, 5)),
        _compact_date(_cell(row, 6)),
        _compact_date(_cell(row, 7)),
        _json_row(row),
    )


def _dpc_surgery_table_record(
    source_id: int,
    workbook_file: str,
    row_index: int,
    row: list[str],
) -> tuple[object, ...] | None:
    mdc_code = _cell(row, 0)
    classification_code = _cell(row, 1)
    surgery_flag = _cell(row, 3)
    if not _looks_like_mdc_code(mdc_code) or not _looks_like_classification_code(
        classification_code
    ):
        return None
    if not surgery_flag or not surgery_flag.isdigit():
        return None
    return (
        source_id,
        workbook_file,
        row_index,
        mdc_code,
        classification_code,
        _cell(row, 2),
        surgery_flag,
        _cell(row, 4),
        _cell(row, 5),
        _cell(row, 6),
        _cell(row, 7),
        _cell(row, 8),
        _cell(row, 9),
        _cell(row, 10),
        _cell(row, 11),
        _cell(row, 12),
        _cell(row, 13),
        _cell(row, 14),
        _cell(row, 15),
        _cell(row, 16),
        _compact_date(_cell(row, 17)),
        _compact_date(_cell(row, 18)),
        _compact_date(_cell(row, 19)),
        _json_row(row),
    )


def _dpc_piecework_surgery_code_record(
    source_id: int,
    workbook_file: str,
    row_index: int,
    row: list[str],
) -> tuple[object, ...] | None:
    category_code = _cell(row, 0)
    surgery_code = _cell(row, 1)
    surgery_name = _cell(row, 2)
    if not category_code.isdigit() or len(category_code) != 2 or not surgery_name:
        return None
    return (
        source_id,
        workbook_file,
        row_index,
        category_code,
        surgery_code,
        surgery_name,
        _cell(row, 3),
        _compact_date(_cell(row, 4)),
        _compact_date(_cell(row, 5)),
        _compact_date(_cell(row, 6)),
        _json_row(row),
    )


def _cell(row: list[str], index: int) -> str:
    if index >= len(row):
        return ""
    return row[index].strip()


def _int_value(value: str) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _looks_like_dpc_code(value: str) -> bool:
    return len(value) == 14 and value[:6].isdigit()


def _looks_like_mdc_code(value: str) -> bool:
    return len(value) == 2 and value.isdigit()


def _looks_like_classification_code(value: str) -> bool:
    return len(value) == 4 and value.isdigit()


def _json_row(row: list[str]) -> str:
    return json.dumps(row, ensure_ascii=False, separators=(",", ":"))


def _trim_row(row: list[str]) -> list[str]:
    trimmed = [value.strip() for value in row]
    while trimmed and not trimmed[-1]:
        trimmed.pop()
    return trimmed


def _has_value(row: list[str]) -> bool:
    return any(value.strip() for value in row)


def _has_japanese_or_alpha(value: str) -> bool:
    return any(char.isalpha() or "\u3040" <= char <= "\u9fff" for char in value)


def _optional_text(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


def _escape_markdown_table_cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")
