from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping


MEDICAL_PROCEDURE_COLUMN_COUNT = 150
DRUG_MASTER_COLUMN_COUNT = 42
SPECIFIC_MATERIAL_COLUMN_COUNT = 38
COMMENT_MASTER_COLUMN_COUNT = 30
COMMENT_LINK_COLUMN_COUNT = 30

ELECTRONIC_AUX_MASTER_COLUMN_COUNT = 27
ELECTRONIC_BUNDLE_COLUMN_COUNT = 7
ELECTRONIC_EXCLUSION_COLUMN_COUNT = 10
ELECTRONIC_INPATIENT_BASIC_COLUMN_COUNT = 8
ELECTRONIC_FREQUENCY_COLUMN_COUNT = 14

ELECTRONIC_TABLE_NAMES = {
    "aux_master",
    "bundles",
    "exclusions_day",
    "exclusions_month",
    "exclusions_simultaneous",
    "exclusions_week",
    "inpatient_basic",
    "frequency_limits",
}


@dataclass(frozen=True)
class ImportResult:
    source_id: int
    row_count: int
    checksum_sha256: str


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _compact_date(value: str) -> str | None:
    if not value or value == "00000000":
        return None
    if value == "99999999":
        return "9999-12-31"
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:8]}"
    return value


def _json_array(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def _json_object(values: Mapping[str, str]) -> str:
    return json.dumps(dict(values), ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _read_csv_rows(path: str | Path, encoding: str) -> list[list[str]]:
    with Path(path).open("r", encoding=encoding, newline="") as f:
        return list(csv.reader(f))


def _combined_checksum(paths: Mapping[str, Path]) -> str:
    digest = hashlib.sha256()
    for table_name in sorted(paths):
        digest.update(table_name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(paths[table_name]).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _upsert_source(
    conn: sqlite3.Connection,
    *,
    source_type: str,
    source_version: str,
    raw_path: str,
    checksum_sha256: str,
    row_count: int,
    published_at: str | None,
    url: str | None,
    encoding: str,
    retrieved_at: str | None,
    replace_tables: tuple[str, ...],
) -> int:
    imported_at = datetime.now(UTC).isoformat(timespec="seconds")
    existing = conn.execute(
        """
        SELECT id
        FROM master_sources
        WHERE source_type = ?
          AND source_version = ?
          AND checksum_sha256 = ?
        """,
        (source_type, source_version, checksum_sha256),
    ).fetchone()

    if existing is not None:
        source_id = int(existing["id"])
        for table_name in replace_tables:
            conn.execute(f"DELETE FROM {table_name} WHERE source_id = ?", (source_id,))
        conn.execute(
            """
            UPDATE master_sources
            SET row_count = ?,
                imported_at = ?,
                raw_path = ?,
                published_at = ?,
                url = ?,
                encoding = ?,
                retrieved_at = ?
            WHERE id = ?
            """,
            (
                row_count,
                imported_at,
                raw_path,
                published_at,
                url,
                encoding,
                retrieved_at,
                source_id,
            ),
        )
        return source_id

    cursor = conn.execute(
        """
        INSERT INTO master_sources (
            source_type,
            source_version,
            published_at,
            url,
            raw_path,
            checksum_sha256,
            encoding,
            row_count,
            retrieved_at,
            imported_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source_type,
            source_version,
            published_at,
            url,
            raw_path,
            checksum_sha256,
            encoding,
            row_count,
            retrieved_at,
            imported_at,
        ),
    )
    return int(cursor.lastrowid)


def _medical_procedure_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != MEDICAL_PROCEDURE_COLUMN_COUNT:
        raise ValueError(
            f"medical procedure master row must have "
            f"{MEDICAL_PROCEDURE_COLUMN_COUNT} columns, got {len(row)}"
        )

    facility_standard_codes = [code for code in row[71:81] if code and code != "0"]

    return (
        source_id,
        row[2],
        row[4],
        row[112],
        float(row[11] or 0),
        row[12],
        row[14],
        row[65],
        row[15],
        row[49],
        row[50],
        row[60],
        _json_array(facility_standard_codes),
        row[89],
        row[90],
        row[84],
        row[91],
        row[92],
        row[93],
        row[94],
        row[95],
        row[85],
        row[96],
        row[97],
        row[98],
        _compact_date(row[86]),
        _compact_date(row[87]),
        _json_array(row),
    )


def _drug_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != DRUG_MASTER_COLUMN_COUNT:
        raise ValueError(f"drug master row must have {DRUG_MASTER_COLUMN_COUNT} columns, got {len(row)}")

    return (
        source_id,
        row[2],
        row[4],
        row[6],
        row[7],
        row[9],
        row[10],
        float(row[11] or 0),
        row[13],
        row[14],
        row[15],
        row[16],
        row[18],
        row[19],
        row[20],
        row[21],
        row[22],
        row[27],
        _compact_date(row[29]),
        _compact_date(row[30]),
        row[31],
        row[32],
        _compact_date(row[33]),
        row[34],
        _compact_date(row[35]),
        row[36],
        row[37],
        row[38],
        row[39],
        row[40],
        row[41],
        _json_array(row),
    )


def _specific_material_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != SPECIFIC_MATERIAL_COLUMN_COUNT:
        raise ValueError(
            f"specific material master row must have {SPECIFIC_MATERIAL_COLUMN_COUNT} columns, "
            f"got {len(row)}"
        )

    return (
        source_id,
        row[2],
        row[4],
        row[6],
        row[7],
        row[9],
        row[10],
        float(row[11] or 0),
        row[13],
        row[14],
        row[15],
        row[20],
        row[21],
        row[22],
        float(row[23] or 0) if row[23] else None,
        row[25],
        row[26],
        _compact_date(row[27]),
        _compact_date(row[28]),
        _compact_date(row[29]),
        row[30],
        row[31],
        row[32],
        row[36],
        row[37],
        _json_array(row),
    )


def _comment_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != COMMENT_MASTER_COLUMN_COUNT:
        raise ValueError(
            f"comment master row must have {COMMENT_MASTER_COLUMN_COUNT} columns, got {len(row)}"
        )

    code = row[22] or f"{row[2]}{row[3]}{row[4]}"
    return (
        source_id,
        code,
        row[6],
        row[8],
        _compact_date(row[20]),
        _compact_date(row[21]),
        _json_array(row),
    )


def _comment_link_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != COMMENT_LINK_COLUMN_COUNT:
        raise ValueError(
            f"comment link row must have {COMMENT_LINK_COLUMN_COUNT} columns, got {len(row)}"
        )

    return (
        source_id,
        row[5],
        row[7],
        row[8],
        row[10],
        row[3],
        row[2],
        row[4],
        row[13],
        _compact_date(row[11]),
        _compact_date(row[12]),
        _json_array(row),
    )


def _electronic_aux_master_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != ELECTRONIC_AUX_MASTER_COLUMN_COUNT:
        raise ValueError(
            f"electronic aux master row must have "
            f"{ELECTRONIC_AUX_MASTER_COLUMN_COUNT} columns, got {len(row)}"
        )

    return (
        source_id,
        row[1],
        row[2],
        row[4],
        _compact_date(row[25]),
        _compact_date(row[26]),
        _json_array(row),
    )


def _electronic_bundle_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != ELECTRONIC_BUNDLE_COLUMN_COUNT:
        raise ValueError(
            f"electronic bundle row must have {ELECTRONIC_BUNDLE_COLUMN_COUNT} columns, "
            f"got {len(row)}"
        )

    return (
        source_id,
        row[1],
        row[2],
        row[3],
        row[4],
        _compact_date(row[5]),
        _compact_date(row[6]),
        _json_array(row),
    )


def _electronic_exclusion_record(
    source_id: int,
    exclusion_table: str,
    row: list[str],
) -> tuple[object, ...]:
    if len(row) != ELECTRONIC_EXCLUSION_COLUMN_COUNT:
        raise ValueError(
            f"electronic exclusion row must have {ELECTRONIC_EXCLUSION_COLUMN_COUNT} columns, "
            f"got {len(row)}"
        )

    return (
        source_id,
        exclusion_table,
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
        _compact_date(row[8]),
        _compact_date(row[9]),
        _json_array(row),
    )


def _electronic_inpatient_basic_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != ELECTRONIC_INPATIENT_BASIC_COLUMN_COUNT:
        raise ValueError(
            f"electronic inpatient basic row must have "
            f"{ELECTRONIC_INPATIENT_BASIC_COLUMN_COUNT} columns, got {len(row)}"
        )

    return (
        source_id,
        row[1],
        row[2],
        row[3],
        row[4],
        _compact_date(row[6]),
        _compact_date(row[7]),
        _json_array(row),
    )


def _electronic_frequency_record(source_id: int, row: list[str]) -> tuple[object, ...]:
    if len(row) != ELECTRONIC_FREQUENCY_COLUMN_COUNT:
        raise ValueError(
            f"electronic frequency row must have {ELECTRONIC_FREQUENCY_COLUMN_COUNT} columns, "
            f"got {len(row)}"
        )

    return (
        source_id,
        row[1],
        row[2],
        row[3],
        row[4],
        _compact_date(row[12]),
        _compact_date(row[13]),
        _json_array(row),
    )


def import_medical_procedure_master(
    conn: sqlite3.Connection,
    csv_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "cp932",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import the official medical procedure master CSV into normalized tables."""

    path = Path(csv_path)
    checksum = sha256_file(path)
    imported_at = datetime.now(UTC).isoformat(timespec="seconds")

    with path.open("r", encoding=encoding, newline="") as f:
        rows = list(csv.reader(f))

    with conn:
        existing = conn.execute(
            """
            SELECT id
            FROM master_sources
            WHERE source_type = ?
              AND source_version = ?
              AND checksum_sha256 = ?
            """,
            ("medical_procedure_master", source_version, checksum),
        ).fetchone()

        if existing is not None:
            source_id = int(existing["id"])
            conn.execute("DELETE FROM medical_procedures WHERE source_id = ?", (source_id,))
            conn.execute(
                """
                UPDATE master_sources
                SET row_count = ?,
                    imported_at = ?,
                    raw_path = ?,
                    published_at = ?,
                    url = ?,
                    encoding = ?,
                    retrieved_at = ?
                WHERE id = ?
                """,
                (
                    len(rows),
                    imported_at,
                    str(path),
                    published_at,
                    url,
                    encoding,
                    retrieved_at,
                    source_id,
                ),
            )
        else:
            cursor = conn.execute(
                """
                INSERT INTO master_sources (
                    source_type,
                    source_version,
                    published_at,
                    url,
                    raw_path,
                    checksum_sha256,
                    encoding,
                    row_count,
                    retrieved_at,
                    imported_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "medical_procedure_master",
                    source_version,
                    published_at,
                    url,
                    str(path),
                    checksum,
                    encoding,
                    len(rows),
                    retrieved_at,
                    imported_at,
                ),
            )
            source_id = int(cursor.lastrowid)

        conn.executemany(
            """
            INSERT INTO medical_procedures (
                source_id,
                code,
                short_name,
                base_name,
                points,
                inout_applicability,
                outpatient_aggregate,
                inpatient_aggregate,
                bundle_lab_group,
                judgement_kind,
                judgement_group,
                specimen_comment_flag,
                facility_standard_codes,
                chapter,
                part,
                alpha_part,
                section,
                branch,
                item,
                notice_chapter,
                notice_part,
                notice_alpha_part,
                notice_section,
                notice_branch,
                notice_item,
                effective_from,
                effective_to,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (_medical_procedure_record(source_id, row) for row in rows),
        )

    return ImportResult(source_id=source_id, row_count=len(rows), checksum_sha256=checksum)


def import_drug_master(
    conn: sqlite3.Connection,
    csv_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "cp932",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import the official drug master CSV."""

    path = Path(csv_path)
    checksum = sha256_file(path)
    rows = _read_csv_rows(path, encoding)

    with conn:
        source_id = _upsert_source(
            conn,
            source_type="drug_master",
            source_version=source_version,
            raw_path=str(path),
            checksum_sha256=checksum,
            row_count=len(rows),
            published_at=published_at,
            url=url,
            encoding=encoding,
            retrieved_at=retrieved_at,
            replace_tables=("drugs",),
        )
        conn.executemany(
            """
            INSERT INTO drugs (
                source_id,
                code,
                name,
                kana,
                unit_code,
                unit_name,
                amount_kind,
                unit_amount_yen,
                narcotic_psychotropic_flag,
                nerve_destroying_agent_flag,
                biologic_flag,
                generic_flag,
                dental_specific_drug_flag,
                contrast_agent_flag,
                injection_volume,
                listing_method_flag,
                product_related_code,
                dosage_form,
                changed_at,
                discontinued_at,
                reimbursement_code,
                publication_order,
                transitional_date,
                base_name,
                listed_at,
                generic_name_code,
                generic_prescription_text,
                generic_prescription_add_on_flag,
                anti_hiv_flag,
                long_listed_related_code,
                selective_treatment_flag,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (_drug_record(source_id, row) for row in rows),
        )

    return ImportResult(source_id=source_id, row_count=len(rows), checksum_sha256=checksum)


def import_specific_material_master(
    conn: sqlite3.Connection,
    csv_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "cp932",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import the official specific material master CSV."""

    path = Path(csv_path)
    checksum = sha256_file(path)
    rows = _read_csv_rows(path, encoding)

    with conn:
        source_id = _upsert_source(
            conn,
            source_type="specific_material_master",
            source_version=source_version,
            raw_path=str(path),
            checksum_sha256=checksum,
            row_count=len(rows),
            published_at=published_at,
            url=url,
            encoding=encoding,
            retrieved_at=retrieved_at,
            replace_tables=("specific_materials",),
        )
        conn.executemany(
            """
            INSERT INTO specific_materials (
                source_id,
                code,
                name,
                kana,
                unit_code,
                unit_name,
                amount_kind,
                unit_amount_yen,
                age_addition_kind,
                min_age,
                max_age,
                oxygen_kind,
                material_kind,
                upper_price_flag,
                upper_points,
                publication_order,
                discontinued_related_code,
                changed_at,
                transitional_date,
                discontinued_at,
                notification_table_no,
                notification_section_no,
                dpc_applicability,
                base_name,
                reprocessed_single_use_device_flag,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (_specific_material_record(source_id, row) for row in rows),
        )

    return ImportResult(source_id=source_id, row_count=len(rows), checksum_sha256=checksum)


def import_comment_master(
    conn: sqlite3.Connection,
    csv_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "cp932",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import the official comment master CSV."""

    path = Path(csv_path)
    checksum = sha256_file(path)
    rows = _read_csv_rows(path, encoding)

    with conn:
        source_id = _upsert_source(
            conn,
            source_type="comment_master",
            source_version=source_version,
            raw_path=str(path),
            checksum_sha256=checksum,
            row_count=len(rows),
            published_at=published_at,
            url=url,
            encoding=encoding,
            retrieved_at=retrieved_at,
            replace_tables=("comments",),
        )
        conn.executemany(
            """
            INSERT INTO comments (
                source_id,
                code,
                comment_text,
                kana,
                effective_from,
                effective_to,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (_comment_record(source_id, row) for row in rows),
        )

    return ImportResult(source_id=source_id, row_count=len(rows), checksum_sha256=checksum)


def import_comment_links(
    conn: sqlite3.Connection,
    csv_path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "cp932",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import the official comment related table CSV."""

    path = Path(csv_path)
    checksum = sha256_file(path)
    rows = _read_csv_rows(path, encoding)

    with conn:
        source_id = _upsert_source(
            conn,
            source_type="comment_related_table",
            source_version=source_version,
            raw_path=str(path),
            checksum_sha256=checksum,
            row_count=len(rows),
            published_at=published_at,
            url=url,
            encoding=encoding,
            retrieved_at=retrieved_at,
            replace_tables=("comment_links",),
        )
        conn.executemany(
            """
            INSERT INTO comment_links (
                source_id,
                procedure_code,
                procedure_name,
                comment_code,
                comment_text,
                chapter,
                section,
                branch,
                requirement_kind,
                effective_from,
                effective_to,
                raw_row_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (_comment_link_record(source_id, row) for row in rows),
        )

    return ImportResult(source_id=source_id, row_count=len(rows), checksum_sha256=checksum)


def import_electronic_fee_table(
    conn: sqlite3.Connection,
    csv_paths: Mapping[str, str | Path],
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "cp932",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import the official medical electronic fee table CSV bundle."""

    unknown_tables = set(csv_paths) - ELECTRONIC_TABLE_NAMES
    if unknown_tables:
        raise ValueError(f"unknown electronic fee table names: {sorted(unknown_tables)}")

    paths = {name: Path(path) for name, path in csv_paths.items() if path is not None}
    rows_by_table = {name: _read_csv_rows(path, encoding) for name, path in paths.items()}
    checksum = _combined_checksum(paths)
    row_count = sum(len(rows) for rows in rows_by_table.values())
    raw_path = _json_object({name: str(path) for name, path in paths.items()})

    with conn:
        source_id = _upsert_source(
            conn,
            source_type="medical_electronic_fee_table",
            source_version=source_version,
            raw_path=raw_path,
            checksum_sha256=checksum,
            row_count=row_count,
            published_at=published_at,
            url=url,
            encoding=encoding,
            retrieved_at=retrieved_at,
            replace_tables=(
                "electronic_aux_master",
                "electronic_bundles",
                "electronic_exclusions",
                "electronic_inpatient_basic",
                "electronic_frequency_limits",
            ),
        )

        if "aux_master" in rows_by_table:
            conn.executemany(
                """
                INSERT INTO electronic_aux_master (
                    source_id,
                    code,
                    name,
                    group_code,
                    effective_from,
                    effective_to,
                    raw_row_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (_electronic_aux_master_record(source_id, row) for row in rows_by_table["aux_master"]),
            )

        if "bundles" in rows_by_table:
            conn.executemany(
                """
                INSERT INTO electronic_bundles (
                    source_id,
                    bundle_group_code,
                    procedure_code,
                    procedure_name,
                    applicability,
                    effective_from,
                    effective_to,
                    raw_row_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (_electronic_bundle_record(source_id, row) for row in rows_by_table["bundles"]),
            )

        exclusion_rows: list[tuple[object, ...]] = []
        for table_name in (
            "exclusions_day",
            "exclusions_month",
            "exclusions_simultaneous",
            "exclusions_week",
        ):
            for row in rows_by_table.get(table_name, []):
                exclusion_rows.append(_electronic_exclusion_record(source_id, table_name, row))
        if exclusion_rows:
            conn.executemany(
                """
                INSERT INTO electronic_exclusions (
                    source_id,
                    exclusion_table,
                    base_code,
                    base_name,
                    excluded_code,
                    excluded_name,
                    rule_kind,
                    effective_from,
                    effective_to,
                    raw_row_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                exclusion_rows,
            )

        if "inpatient_basic" in rows_by_table:
            conn.executemany(
                """
                INSERT INTO electronic_inpatient_basic (
                    source_id,
                    inpatient_basic_code,
                    procedure_code,
                    procedure_name,
                    applicability,
                    effective_from,
                    effective_to,
                    raw_row_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _electronic_inpatient_basic_record(source_id, row)
                    for row in rows_by_table["inpatient_basic"]
                ),
            )

        if "frequency_limits" in rows_by_table:
            conn.executemany(
                """
                INSERT INTO electronic_frequency_limits (
                    source_id,
                    procedure_code,
                    procedure_name,
                    limit_code,
                    limit_name,
                    effective_from,
                    effective_to,
                    raw_row_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _electronic_frequency_record(source_id, row)
                    for row in rows_by_table["frequency_limits"]
                ),
            )

    return ImportResult(source_id=source_id, row_count=row_count, checksum_sha256=checksum)
