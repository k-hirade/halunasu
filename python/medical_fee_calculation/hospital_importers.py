from __future__ import annotations

import json
import re
import sqlite3
import zipfile
from pathlib import Path

from medical_fee_calculation.importers import ImportResult, _upsert_source, sha256_file
from medical_fee_calculation.japanese_dates import parse_japanese_date
from medical_fee_calculation.xlsx_reader import read_first_sheet_rows, read_first_sheet_rows_from_bytes


HOKKAIDO_BUREAU = "hokkaido"
REGIONAL_BUREAUS = frozenset(
    (
        "hokkaido",
        "tohoku",
        "kanto_shinetsu",
        "tokai_hokuriku",
        "kinki",
        "chugoku_shikoku",
        "shikoku",
        "kyushu",
    )
)
HOKKAIDO_FACILITY_HEADER = [
    "項番",
    "都道府県コード",
    "都道府県名",
    "区分",
    "医療機関番号",
    "併設医療機関番号",
    "医療機関記号番号",
    "医療機関名称",
    "医療機関所在地（郵便番号）",
    "医療機関所在地（住所）",
    "電話番号",
    "FAX番号",
    "病床数",
    "受理届出名称",
    "受理記号",
    "受理番号",
    "算定開始年月日",
]
COMPACT_FACILITY_HEADER = [
    "項番",
    "都道府県コード",
    "都道府県名",
    "受理届出名称",
    "医療機関番号",
    "併設医療機関番号",
    "医療機関記号番号",
    "医療機関名称",
    "医療機関所在地（郵便番号）",
    "医療機関所在地（住所）",
    "電話番号",
    "FAX番号",
    "病床数",
    "受理記号",
    "受理番号",
    "算定開始年月日",
]


def import_hokkaido_hospital_registry(
    conn: sqlite3.Connection,
    xlsx_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    retrieved_at: str | None = None,
) -> ImportResult:
    return import_regional_hospital_registry(
        conn,
        xlsx_path,
        regional_bureau=HOKKAIDO_BUREAU,
        source_version=source_version,
        published_at=published_at,
        url=url,
        retrieved_at=retrieved_at,
    )


def import_regional_hospital_registry(
    conn: sqlite3.Connection,
    xlsx_path: str | Path,
    *,
    regional_bureau: str,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    retrieved_at: str | None = None,
) -> ImportResult:
    bureau = _normalize_regional_bureau(regional_bureau)
    path = Path(xlsx_path)
    records: list[dict[str, object]] = []
    for workbook_name, rows in _read_workbook_row_sets(path):
        if not _is_medical_registry_workbook(rows, workbook_name):
            continue
        for record in _parse_hokkaido_hospital_registry_rows(rows):
            record["source_workbook"] = workbook_name
            records.append(record)
    records = _deduplicate_records(records, key="medical_institution_code")
    checksum = sha256_file(path)

    with conn:
        source_id = _upsert_source(
            conn,
            source_type=f"{bureau}_hospital_registry",
            source_version=source_version,
            raw_path=str(path),
            checksum_sha256=checksum,
            row_count=len(records),
            published_at=published_at,
            url=url,
            encoding=_source_encoding(path),
            retrieved_at=retrieved_at,
            replace_tables=("hospital_registry",),
        )
        conn.executemany(
            """
            INSERT INTO hospital_registry (
                source_id,
                regional_bureau,
                prefecture_code,
                medical_institution_code,
                raw_medical_institution_code,
                institution_name,
                institution_type,
                postal_code,
                address,
                phone,
                founder,
                administrator,
                designated_from,
                status,
                bed_count_text,
                departments_text,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    source_id,
                    bureau,
                    record["prefecture_code"],
                    record["medical_institution_code"],
                    record["raw_medical_institution_code"],
                    record["institution_name"],
                    record["institution_type"],
                    record["postal_code"],
                    record["address"],
                    record["phone"],
                    record["founder"],
                    record["administrator"],
                    record["designated_from"],
                    record["status"],
                    record["bed_count_text"],
                    record["departments_text"],
                    _json(
                        {
                            "workbook": record["source_workbook"],
                            "rows": record["raw_rows"],
                        }
                    ),
                )
                for record in records
            ),
        )

    return ImportResult(source_id=source_id, row_count=len(records), checksum_sha256=checksum)


def import_hokkaido_facility_standards(
    conn: sqlite3.Connection,
    xlsx_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    retrieved_at: str | None = None,
) -> ImportResult:
    return import_regional_facility_standards(
        conn,
        xlsx_path,
        regional_bureau=HOKKAIDO_BUREAU,
        source_version=source_version,
        published_at=published_at,
        url=url,
        retrieved_at=retrieved_at,
    )


def import_regional_facility_standards(
    conn: sqlite3.Connection,
    xlsx_path: str | Path,
    *,
    regional_bureau: str,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    retrieved_at: str | None = None,
) -> ImportResult:
    bureau = _normalize_regional_bureau(regional_bureau)
    path = Path(xlsx_path)
    records: list[dict[str, object]] = []
    for workbook_name, rows in _read_workbook_row_sets(path):
        for record in _parse_hokkaido_facility_standard_rows(rows):
            record["source_workbook"] = workbook_name
            records.append(record)
    checksum = sha256_file(path)

    with conn:
        source_id = _upsert_source(
            conn,
            source_type=f"{bureau}_facility_standards_medical",
            source_version=source_version,
            raw_path=str(path),
            checksum_sha256=checksum,
            row_count=len(records),
            published_at=published_at,
            url=url,
            encoding=_source_encoding(path),
            retrieved_at=retrieved_at,
            replace_tables=("hospital_facility_standards",),
        )
        conn.executemany(
            """
            INSERT INTO hospital_facility_standards (
                source_id,
                regional_bureau,
                prefecture_code,
                prefecture_name,
                category,
                medical_institution_code,
                co_located_medical_institution_code,
                institution_symbol_number,
                institution_name,
                postal_code,
                address,
                phone,
                fax,
                bed_count_text,
                standard_name,
                standard_abbreviation,
                receipt_number,
                start_date,
                individual_effective_start_date,
                remarks_heading,
                remarks_data,
                municipality_code,
                municipality_name,
                type_code,
                type_name,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    source_id,
                    bureau,
                    record["prefecture_code"],
                    record["prefecture_name"],
                    record["category"],
                    record["medical_institution_code"],
                    record["co_located_medical_institution_code"],
                    record["institution_symbol_number"],
                    record["institution_name"],
                    record["postal_code"],
                    record["address"],
                    record["phone"],
                    record["fax"],
                    record["bed_count_text"],
                    record["standard_name"],
                    record["standard_abbreviation"],
                    record["receipt_number"],
                    record["start_date"],
                    record["individual_effective_start_date"],
                    record["remarks_heading"],
                    record["remarks_data"],
                    record["municipality_code"],
                    record["municipality_name"],
                    record["type_code"],
                    record["type_name"],
                    _json(
                        {
                            "workbook": record["source_workbook"],
                            "row": record["raw_row"],
                        }
                    ),
                )
                for record in records
            ),
        )

    return ImportResult(source_id=source_id, row_count=len(records), checksum_sha256=checksum)


def _parse_hokkaido_facility_standard_rows(rows: list[list[str]]) -> list[dict[str, object]]:
    header_index, layout = _find_facility_header(rows)
    records: list[dict[str, object]] = []
    for row in rows[header_index + 1 :]:
        record = (
            _parse_standard_facility_row(row)
            if layout == "standard"
            else _parse_compact_facility_row(row)
        )
        if record is None:
            continue
        records.append(record)
    return records


def _find_facility_header(rows: list[list[str]]) -> tuple[int, str]:
    for index, row in enumerate(rows):
        padded = _pad(row, len(HOKKAIDO_FACILITY_HEADER))
        if padded[: len(HOKKAIDO_FACILITY_HEADER)] == HOKKAIDO_FACILITY_HEADER:
            return index, "standard"

        compact = _pad(row, len(COMPACT_FACILITY_HEADER))
        if compact[: len(COMPACT_FACILITY_HEADER)] == COMPACT_FACILITY_HEADER:
            return index, "compact"
    raise ValueError("expected header row not found")


def _parse_standard_facility_row(row: list[str]) -> dict[str, object] | None:
    padded = _pad(row, 24)
    if not padded[4] or not padded[13]:
        return None
    return {
        "prefecture_code": padded[1],
        "prefecture_name": padded[2],
        "category": padded[3],
        "medical_institution_code": _normalize_medical_code(padded[4]),
        "co_located_medical_institution_code": _normalize_medical_code(padded[5]),
        "institution_symbol_number": padded[6],
        "institution_name": _clean_text(padded[7]),
        "postal_code": _normalize_postal_code(padded[8]),
        "address": _clean_text(padded[9]),
        "phone": padded[10],
        "fax": padded[11],
        "bed_count_text": _clean_text(padded[12]),
        "standard_name": _clean_text(padded[13]),
        "standard_abbreviation": _clean_text(padded[14]),
        "receipt_number": _clean_text(padded[15]),
        "start_date": parse_japanese_date(padded[16]),
        "individual_effective_start_date": parse_japanese_date(padded[17]),
        "remarks_heading": _clean_text(padded[18]),
        "remarks_data": _clean_text(padded[19]),
        "municipality_code": padded[20],
        "municipality_name": padded[21],
        "type_code": padded[22],
        "type_name": padded[23],
        "raw_row": padded,
    }


def _parse_compact_facility_row(row: list[str]) -> dict[str, object] | None:
    padded = _pad(row, 19)
    if not padded[4] or not padded[3]:
        return None
    return {
        "prefecture_code": padded[1],
        "prefecture_name": padded[2],
        "category": "医科",
        "medical_institution_code": _normalize_medical_code(padded[4]),
        "co_located_medical_institution_code": _normalize_medical_code(padded[5]),
        "institution_symbol_number": padded[6],
        "institution_name": _clean_text(padded[7]),
        "postal_code": _normalize_postal_code(padded[8]),
        "address": _clean_text(padded[9]),
        "phone": padded[10],
        "fax": padded[11],
        "bed_count_text": _clean_text(padded[12]),
        "standard_name": _clean_text(padded[3]),
        "standard_abbreviation": _clean_text(padded[13]),
        "receipt_number": _clean_text(padded[14]),
        "start_date": parse_japanese_date(padded[15]),
        "individual_effective_start_date": parse_japanese_date(padded[16]),
        "remarks_heading": _clean_text(padded[17]),
        "remarks_data": _clean_text(padded[18]),
        "municipality_code": "",
        "municipality_name": "",
        "type_code": "",
        "type_name": "",
        "raw_row": padded,
    }


def _normalize_regional_bureau(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9_]+", "_", (value or "").strip().lower()).strip("_")
    if not normalized:
        raise ValueError("regional_bureau is required")
    return normalized


def _read_workbook_row_sets(path: Path) -> list[tuple[str, list[list[str]]]]:
    if path.suffix.lower() != ".zip":
        return [(path.name, read_first_sheet_rows(path))]

    row_sets: list[tuple[str, list[list[str]]]] = []
    with zipfile.ZipFile(path) as archive:
        for member in sorted(archive.namelist()):
            member_name = Path(member).name
            if (
                not member_name
                or member.endswith("/")
                or member.startswith("__MACOSX/")
                or member_name.startswith("~$")
                or not member_name.lower().endswith(".xlsx")
            ):
                continue
            row_sets.append((member, read_first_sheet_rows_from_bytes(archive.read(member))))

    if not row_sets:
        raise ValueError("zip archive contains no .xlsx workbooks")
    return row_sets


def _source_encoding(path: Path) -> str:
    if path.suffix.lower() == ".zip":
        return "zip+xlsx"
    return "xlsx"


def _deduplicate_records(records: list[dict[str, object]], *, key: str) -> list[dict[str, object]]:
    deduplicated: list[dict[str, object]] = []
    seen: set[object] = set()
    for record in records:
        value = record[key]
        if value in seen:
            continue
        seen.add(value)
        deduplicated.append(record)
    return deduplicated


def _parse_hokkaido_hospital_registry_rows(rows: list[list[str]]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    current_rows: list[list[str]] = []
    bed_lines: list[str] = []
    department_lines: list[str] = []
    status: str | None = None

    def flush() -> None:
        nonlocal current, current_rows, bed_lines, department_lines, status
        if current is None:
            return
        current["bed_count_text"] = " / ".join(line for line in bed_lines if line)
        current["departments_text"] = " ".join(line for line in department_lines if line)
        current["status"] = status
        current["raw_rows"] = current_rows
        records.append(current)
        current = None
        current_rows = []
        bed_lines = []
        department_lines = []
        status = None

    for row in rows:
        padded = _pad(row, 10)
        if _is_registry_start_row(padded):
            flush()
            raw_code = padded[1]
            normalized_code = _normalize_medical_code(raw_code)
            postal_code, address = _split_postal_address(padded[3])
            current = {
                "prefecture_code": normalized_code[:2],
                "medical_institution_code": normalized_code,
                "raw_medical_institution_code": raw_code,
                "institution_name": _clean_text(padded[2]),
                "institution_type": _clean_text(padded[9]),
                "postal_code": postal_code,
                "address": address,
                "phone": padded[4],
                "founder": _clean_text(padded[5]),
                "administrator": _clean_text(padded[6]),
                "designated_from": parse_japanese_date(padded[7]),
            }
            current_rows = [padded]
            if padded[8]:
                text = _clean_text(padded[8])
                if _looks_like_bed_count(text):
                    bed_lines.append(text)
                else:
                    department_lines.append(text)
            continue

        if current is None:
            continue

        current_rows.append(padded)
        if padded[8]:
            text = _clean_text(padded[8])
            if _looks_like_bed_count(text):
                bed_lines.append(text)
            else:
                department_lines.append(text)
        if padded[9] in {"現存", "休止", "廃止"}:
            status = padded[9]

    flush()
    return records


def _find_header_index(rows: list[list[str]], required: list[str]) -> int:
    for index, row in enumerate(rows):
        padded = _pad(row, len(required))
        if padded[: len(required)] == required:
            return index
    raise ValueError("expected header row not found")


def _is_registry_start_row(row: list[str]) -> bool:
    return bool(re.fullmatch(r"\d+", row[0] or "") and _looks_like_registry_code(row[1]))


def _looks_like_registry_code(value: str) -> bool:
    text = _clean_text(value)
    if re.search(r"[A-Za-zぁ-んァ-ヶ一-龠]", text):
        return False
    return len(_normalize_medical_code(text)) == 7


def _is_medical_registry_workbook(rows: list[list[str]], workbook_name: str) -> bool:
    context = _clean_text(" ".join(cell for row in rows[:8] for cell in row[:4]))
    name = Path(workbook_name).name.lower()
    name_tokens = set(re.split(r"[^a-z0-9]+", name))

    if "薬局" in context or "yakkyoku" in name_tokens:
        return False
    if ("歯科" in context and "医科" not in context) or "shika" in name_tokens:
        return False
    return True


def _normalize_medical_code(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def _normalize_postal_code(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 7:
        return f"{digits[:3]}-{digits[3:]}"
    return value


def _split_postal_address(value: str) -> tuple[str | None, str]:
    text = _clean_text(value).replace("－", "-")
    match = re.match(r"〒?(\d{3})[-ー－]?(\d{4})(.*)", text)
    if not match:
        return None, text
    return f"{match.group(1)}-{match.group(2)}", match.group(3).strip()


def _looks_like_bed_count(value: str) -> bool:
    return bool(re.search(r"(一般|療養|精神|結核|感染|病床)", value))


def _pad(row: list[str], width: int) -> list[str]:
    return row + [""] * max(0, width - len(row))


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\u3000", " ")).strip()


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
