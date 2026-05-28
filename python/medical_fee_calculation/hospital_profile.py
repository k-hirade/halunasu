from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.hospital_quality import (
    HOSPITAL_INSTITUTION_TYPES,
    classify_hospital_default_run,
)


@dataclass(frozen=True)
class FacilityStandard:
    standard_abbreviation: str
    standard_name: str
    receipt_number: str
    start_date: str | None


@dataclass(frozen=True)
class DpcHospitalCoefficient:
    institution_name: str
    hospital_group: str | None
    base_coefficient: float | None
    functional_evaluation_coefficient_i: float | None
    functional_evaluation_coefficient_ii: float | None
    emergency_correction_coefficient: float | None
    mitigation_coefficient: float | None
    total_coefficient: float
    effective_from: str | None
    effective_to: str | None


@dataclass(frozen=True)
class HospitalProfile:
    medical_institution_code: str
    institution_name: str | None
    institution_type: str | None
    status: str | None
    bed_count_text: str | None
    departments_text: str | None
    facility_standards: tuple[FacilityStandard, ...]
    warnings: tuple[str, ...]
    dpc_hospital_coefficient: DpcHospitalCoefficient | None = None
    default_run_classification: str | None = None
    default_run_recommended_action: str | None = None
    included_in_default_medical_run: bool | None = None

    @property
    def facility_standard_keys(self) -> frozenset[str]:
        return frozenset(
            standard.standard_abbreviation
            for standard in self.facility_standards
            if standard.standard_abbreviation
        )


def get_hospital_profile(
    conn: sqlite3.Connection,
    medical_institution_code: str,
    service_date: date,
    *,
    regional_bureau: str | None = None,
    registry_source_id: int | None = None,
    facility_source_id: int | None = None,
    dpc_coefficient_source_id: int | None = None,
) -> HospitalProfile:
    code = normalize_medical_institution_code(medical_institution_code)
    service_date_text = service_date.isoformat()
    warnings: list[str] = []

    registry = _fetch_registry(conn, code, registry_source_id, regional_bureau)
    if registry is None:
        warnings.append("hospital_registry_not_found")
        default_run_classification = None
        default_run_recommended_action = None
        included_in_default_medical_run = None
        institution_name = None
        institution_type = None
        status = None
        bed_count_text = None
        departments_text = None
    else:
        institution_name = registry["institution_name"]
        institution_type = registry["institution_type"]
        status = registry["status"]
        bed_count_text = registry["bed_count_text"]
        departments_text = registry["departments_text"]

    standards = _fetch_facility_standards(
        conn,
        code,
        service_date_text,
        facility_source_id,
        regional_bureau,
    )
    if not standards:
        warnings.append("facility_standards_not_found")

    dpc_hospital_coefficient = _fetch_dpc_hospital_coefficient(
        conn,
        code,
        institution_name,
        service_date_text,
        dpc_coefficient_source_id,
    )

    if registry is not None:
        if institution_type not in HOSPITAL_INSTITUTION_TYPES or status != "現存":
            default_run_classification = "registry_scope_review"
            default_run_recommended_action = "exclude_from_default_medical_run"
            included_in_default_medical_run = False
        else:
            (
                default_run_classification,
                default_run_recommended_action,
                included_in_default_medical_run,
                default_run_warnings,
            ) = classify_hospital_default_run(
                institution_name=str(institution_name or ""),
                bed_count_text=str(bed_count_text or ""),
                facility_standard_count=len(standards),
            )
            warnings.extend(default_run_warnings)

        if included_in_default_medical_run is False:
            warnings.append(
                "default_medical_run_excluded: "
                f"{default_run_classification}"
            )

    warnings = list(dict.fromkeys(warnings))

    return HospitalProfile(
        medical_institution_code=code,
        institution_name=institution_name,
        institution_type=institution_type,
        status=status,
        bed_count_text=bed_count_text,
        departments_text=departments_text,
        facility_standards=standards,
        warnings=tuple(warnings),
        dpc_hospital_coefficient=dpc_hospital_coefficient,
        default_run_classification=default_run_classification,
        default_run_recommended_action=default_run_recommended_action,
        included_in_default_medical_run=included_in_default_medical_run,
    )


def normalize_medical_institution_code(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def normalize_institution_name(value: str | None) -> str:
    text = str(value or "")
    text = text.replace("　", " ").strip()
    text = re.sub(r"\s+", "", text)
    return text.replace("（", "(").replace("）", ")")


def _fetch_registry(
    conn: sqlite3.Connection,
    medical_institution_code: str,
    source_id: int | None,
    regional_bureau: str | None,
) -> sqlite3.Row | None:
    regional_filter = ""
    params: list[object]
    if regional_bureau is not None:
        regional_filter = "AND regional_bureau = ?"

    if source_id is not None:
        params = [source_id, medical_institution_code]
        if regional_bureau is not None:
            params.append(regional_bureau)
        return conn.execute(
            f"""
            SELECT *
            FROM hospital_registry
            WHERE source_id = ?
              AND medical_institution_code = ?
              {regional_filter}
            """,
            params,
        ).fetchone()

    params = [medical_institution_code]
    if regional_bureau is not None:
        params.append(regional_bureau)
    return conn.execute(
        f"""
        SELECT *
        FROM hospital_registry
        WHERE medical_institution_code = ?
          {regional_filter}
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _fetch_facility_standards(
    conn: sqlite3.Connection,
    medical_institution_code: str,
    service_date: str,
    source_id: int | None,
    regional_bureau: str | None,
) -> tuple[FacilityStandard, ...]:
    params: list[object] = [medical_institution_code, service_date]
    filters: list[str] = []
    if regional_bureau is not None:
        filters.append("AND regional_bureau = ?")
        params.append(regional_bureau)
    if source_id is not None:
        filters.append("AND source_id = ?")
        params.append(source_id)
    extra_filters = "\n          ".join(filters)

    rows = conn.execute(
        f"""
        SELECT
            standard_abbreviation,
            standard_name,
            receipt_number,
            start_date
        FROM hospital_facility_standards
        WHERE medical_institution_code = ?
          AND (start_date IS NULL OR start_date <= ?)
          {extra_filters}
        ORDER BY standard_abbreviation, standard_name, receipt_number
        """,
        params,
    ).fetchall()

    return tuple(
        FacilityStandard(
            standard_abbreviation=str(row["standard_abbreviation"] or ""),
            standard_name=str(row["standard_name"] or ""),
            receipt_number=str(row["receipt_number"] or ""),
            start_date=row["start_date"],
        )
        for row in rows
    )


def _fetch_dpc_hospital_coefficient(
    conn: sqlite3.Connection,
    medical_institution_code: str,
    institution_name: str | None,
    service_date: str,
    source_id: int | None,
) -> DpcHospitalCoefficient | None:
    if not _table_exists(conn, "dpc_hospital_coefficients"):
        return None

    source_filter = ""
    params: list[object] = [service_date, service_date, medical_institution_code]
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    row = conn.execute(
        f"""
        SELECT *
        FROM dpc_hospital_coefficients
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND medical_institution_code = ?
          {source_filter}
        ORDER BY source_id DESC, row_index DESC
        LIMIT 1
        """,
        params,
    ).fetchone()
    if row is None and institution_name:
        normalized_name = normalize_institution_name(institution_name)
        name_params: list[object] = [service_date, service_date, normalized_name]
        name_source_filter = ""
        if source_id is not None:
            name_source_filter = "AND source_id = ?"
            name_params.append(source_id)
        matches = conn.execute(
            f"""
            SELECT *
            FROM dpc_hospital_coefficients
            WHERE (effective_from IS NULL OR effective_from <= ?)
              AND (effective_to IS NULL OR effective_to >= ?)
              AND normalized_institution_name = ?
              {name_source_filter}
            ORDER BY source_id DESC, row_index DESC
            LIMIT 2
            """,
            name_params,
        ).fetchall()
        if len(matches) == 1 or (
            len(matches) == 2 and matches[0]["source_id"] != matches[1]["source_id"]
        ):
            row = matches[0]
    if row is None:
        return None

    return DpcHospitalCoefficient(
        institution_name=str(row["institution_name"]),
        hospital_group=row["hospital_group"],
        base_coefficient=row["base_coefficient"],
        functional_evaluation_coefficient_i=row["functional_evaluation_coefficient_i"],
        functional_evaluation_coefficient_ii=row["functional_evaluation_coefficient_ii"],
        emergency_correction_coefficient=row["emergency_correction_coefficient"],
        mitigation_coefficient=row["mitigation_coefficient"],
        total_coefficient=float(row["total_coefficient"]),
        effective_from=row["effective_from"],
        effective_to=row["effective_to"],
    )


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return (
        conn.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table'
              AND name = ?
            LIMIT 1
            """,
            (table_name,),
        ).fetchone()
        is not None
    )
