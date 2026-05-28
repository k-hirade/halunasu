from __future__ import annotations

import sqlite3
from dataclasses import dataclass


HOSPITAL_INSTITUTION_TYPES = ("病院", "特定機能", "地域支援", "総合病院")


@dataclass(frozen=True)
class HospitalRegistryQualitySummary:
    regional_bureau: str
    registry_rows: int
    hospital_rows: int
    active_hospital_rows: int
    facility_standard_institution_count: int
    active_hospital_with_facility_standard_count: int
    active_hospital_without_facility_standard_count: int

    def to_dict(self) -> dict[str, int | str]:
        return {
            "regional_bureau": self.regional_bureau,
            "registry_rows": self.registry_rows,
            "hospital_rows": self.hospital_rows,
            "active_hospital_rows": self.active_hospital_rows,
            "facility_standard_institution_count": self.facility_standard_institution_count,
            "active_hospital_with_facility_standard_count": (
                self.active_hospital_with_facility_standard_count
            ),
            "active_hospital_without_facility_standard_count": (
                self.active_hospital_without_facility_standard_count
            ),
        }


@dataclass(frozen=True)
class UnmatchedActiveHospital:
    regional_bureau: str
    medical_institution_code: str
    institution_name: str
    address: str
    bed_count_text: str
    departments_text: str
    same_bureau_name_match_count: int
    classification: str
    recommended_action: str

    def to_dict(self) -> dict[str, int | str]:
        return {
            "regional_bureau": self.regional_bureau,
            "medical_institution_code": self.medical_institution_code,
            "institution_name": self.institution_name,
            "address": self.address,
            "bed_count_text": self.bed_count_text,
            "departments_text": self.departments_text,
            "same_bureau_name_match_count": self.same_bureau_name_match_count,
            "classification": self.classification,
            "recommended_action": self.recommended_action,
        }


@dataclass(frozen=True)
class HospitalRunTarget:
    regional_bureau: str
    medical_institution_code: str
    institution_name: str
    address: str
    bed_count_text: str
    departments_text: str
    facility_standard_count: int
    classification: str
    recommended_action: str
    included_in_default_run: bool
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, bool | int | str | tuple[str, ...]]:
        return {
            "regional_bureau": self.regional_bureau,
            "medical_institution_code": self.medical_institution_code,
            "institution_name": self.institution_name,
            "address": self.address,
            "bed_count_text": self.bed_count_text,
            "departments_text": self.departments_text,
            "facility_standard_count": self.facility_standard_count,
            "classification": self.classification,
            "recommended_action": self.recommended_action,
            "included_in_default_run": self.included_in_default_run,
            "warnings": self.warnings,
        }


@dataclass(frozen=True)
class HospitalRunTargetSummary:
    included_in_default_run: bool
    classification: str
    recommended_action: str
    count: int

    def to_dict(self) -> dict[str, bool | int | str]:
        return {
            "included_in_default_run": self.included_in_default_run,
            "classification": self.classification,
            "recommended_action": self.recommended_action,
            "count": self.count,
        }


def summarize_hospital_registry_quality(
    conn: sqlite3.Connection,
) -> list[HospitalRegistryQualitySummary]:
    rows = conn.execute(
        """
        WITH bureau_keys AS (
            SELECT regional_bureau FROM hospital_registry
            UNION
            SELECT regional_bureau FROM hospital_facility_standards
        ),
        facility_codes AS (
            SELECT DISTINCT regional_bureau, medical_institution_code
            FROM hospital_facility_standards
        ),
        registry_summary AS (
            SELECT
                hr.regional_bureau,
                COUNT(*) AS registry_rows,
                SUM(
                    CASE
                        WHEN hr.institution_type IN ('病院', '特定機能', '地域支援', '総合病院')
                        THEN 1
                        ELSE 0
                    END
                ) AS hospital_rows,
                SUM(
                    CASE
                        WHEN hr.institution_type IN ('病院', '特定機能', '地域支援', '総合病院')
                         AND hr.status = '現存'
                        THEN 1
                        ELSE 0
                    END
                ) AS active_hospital_rows,
                SUM(
                    CASE
                        WHEN hr.institution_type IN ('病院', '特定機能', '地域支援', '総合病院')
                         AND hr.status = '現存'
                         AND fc.medical_institution_code IS NOT NULL
                        THEN 1
                        ELSE 0
                    END
                ) AS active_hospital_with_facility_standard_count
            FROM hospital_registry hr
            LEFT JOIN facility_codes fc
              ON fc.regional_bureau = hr.regional_bureau
             AND fc.medical_institution_code = hr.medical_institution_code
            GROUP BY hr.regional_bureau
        ),
        facility_summary AS (
            SELECT
                regional_bureau,
                COUNT(*) AS facility_standard_institution_count
            FROM facility_codes
            GROUP BY regional_bureau
        )
        SELECT
            bk.regional_bureau,
            COALESCE(rs.registry_rows, 0) AS registry_rows,
            COALESCE(rs.hospital_rows, 0) AS hospital_rows,
            COALESCE(rs.active_hospital_rows, 0) AS active_hospital_rows,
            COALESCE(fs.facility_standard_institution_count, 0) AS facility_standard_institution_count,
            COALESCE(
                rs.active_hospital_with_facility_standard_count,
                0
            ) AS active_hospital_with_facility_standard_count
        FROM bureau_keys bk
        LEFT JOIN registry_summary rs ON rs.regional_bureau = bk.regional_bureau
        LEFT JOIN facility_summary fs ON fs.regional_bureau = bk.regional_bureau
        ORDER BY bk.regional_bureau
        """
    ).fetchall()

    summaries: list[HospitalRegistryQualitySummary] = []
    for row in rows:
        active_hospital_rows = int(row["active_hospital_rows"])
        active_hospital_with_facility_count = int(
            row["active_hospital_with_facility_standard_count"]
        )
        summaries.append(
            HospitalRegistryQualitySummary(
                regional_bureau=str(row["regional_bureau"]),
                registry_rows=int(row["registry_rows"]),
                hospital_rows=int(row["hospital_rows"]),
                active_hospital_rows=active_hospital_rows,
                facility_standard_institution_count=int(row["facility_standard_institution_count"]),
                active_hospital_with_facility_standard_count=active_hospital_with_facility_count,
                active_hospital_without_facility_standard_count=(
                    active_hospital_rows - active_hospital_with_facility_count
                ),
            )
        )
    return summaries


def list_unmatched_active_hospitals(
    conn: sqlite3.Connection,
) -> list[UnmatchedActiveHospital]:
    rows = conn.execute(
        """
        WITH facility_codes AS (
            SELECT DISTINCT regional_bureau, medical_institution_code
            FROM hospital_facility_standards
        ),
        facility_names AS (
            SELECT
                regional_bureau,
                REPLACE(REPLACE(institution_name, ' ', ''), '　', '') AS normalized_name,
                COUNT(DISTINCT medical_institution_code) AS same_bureau_name_match_count
            FROM hospital_facility_standards
            GROUP BY regional_bureau, normalized_name
        ),
        unmatched AS (
            SELECT
                hr.regional_bureau,
                hr.medical_institution_code,
                hr.institution_name,
                hr.address,
                hr.bed_count_text,
                hr.departments_text,
                REPLACE(REPLACE(hr.institution_name, ' ', ''), '　', '') AS normalized_name
            FROM hospital_registry hr
            LEFT JOIN facility_codes fc
              ON fc.regional_bureau = hr.regional_bureau
             AND fc.medical_institution_code = hr.medical_institution_code
            WHERE hr.institution_type IN ('病院', '特定機能', '地域支援', '総合病院')
              AND hr.status = '現存'
              AND fc.medical_institution_code IS NULL
        )
        SELECT
            u.regional_bureau,
            u.medical_institution_code,
            u.institution_name,
            u.address,
            u.bed_count_text,
            u.departments_text,
            COALESCE(fn.same_bureau_name_match_count, 0) AS same_bureau_name_match_count
        FROM unmatched u
        LEFT JOIN facility_names fn
          ON fn.regional_bureau = u.regional_bureau
         AND fn.normalized_name = u.normalized_name
        ORDER BY u.regional_bureau, u.medical_institution_code
        """
    ).fetchall()

    hospitals: list[UnmatchedActiveHospital] = []
    for row in rows:
        institution_name = str(row["institution_name"] or "")
        bed_count_text = str(row["bed_count_text"] or "")
        classification, recommended_action = _classify_unmatched_active_hospital(
            institution_name=institution_name,
            bed_count_text=bed_count_text,
        )
        hospitals.append(
            UnmatchedActiveHospital(
                regional_bureau=str(row["regional_bureau"]),
                medical_institution_code=str(row["medical_institution_code"]),
                institution_name=institution_name,
                address=str(row["address"] or ""),
                bed_count_text=bed_count_text,
                departments_text=str(row["departments_text"] or ""),
                same_bureau_name_match_count=int(row["same_bureau_name_match_count"]),
                classification=classification,
                recommended_action=recommended_action,
            )
        )
    return hospitals


def classify_hospital_default_run(
    *,
    institution_name: str,
    bed_count_text: str,
    facility_standard_count: int,
) -> tuple[str, str, bool, tuple[str, ...]]:
    scope_review = _classify_hospital_scope_review(
        institution_name=institution_name,
        bed_count_text=bed_count_text,
    )
    if scope_review is not None:
        classification, recommended_action = scope_review
        return classification, recommended_action, False, ()
    if facility_standard_count > 0:
        return "facility_standards_matched", "include", True, ()
    if not _has_bed_count(bed_count_text):
        return "bed_count_missing_review", "needs_review", False, ()
    return (
        "facility_standards_missing",
        "include_with_facility_warning",
        True,
        ("facility_standards_not_found",),
    )


def list_hospital_run_targets(
    conn: sqlite3.Connection,
    *,
    include_excluded: bool = False,
) -> list[HospitalRunTarget]:
    rows = conn.execute(
        """
        WITH facility_counts AS (
            SELECT
                regional_bureau,
                medical_institution_code,
                COUNT(*) AS facility_standard_count
            FROM hospital_facility_standards
            GROUP BY regional_bureau, medical_institution_code
        )
        SELECT
            hr.regional_bureau,
            hr.medical_institution_code,
            hr.institution_name,
            hr.address,
            hr.bed_count_text,
            hr.departments_text,
            COALESCE(fc.facility_standard_count, 0) AS facility_standard_count
        FROM hospital_registry hr
        LEFT JOIN facility_counts fc
          ON fc.regional_bureau = hr.regional_bureau
         AND fc.medical_institution_code = hr.medical_institution_code
        WHERE hr.institution_type IN ('病院', '特定機能', '地域支援', '総合病院')
          AND hr.status = '現存'
        ORDER BY hr.regional_bureau, hr.medical_institution_code
        """
    ).fetchall()

    targets: list[HospitalRunTarget] = []
    for row in rows:
        facility_standard_count = int(row["facility_standard_count"])
        institution_name = str(row["institution_name"] or "")
        bed_count_text = str(row["bed_count_text"] or "")
        classification, recommended_action, included, warnings = classify_hospital_default_run(
            institution_name=institution_name,
            bed_count_text=bed_count_text,
            facility_standard_count=facility_standard_count,
        )

        if not included and not include_excluded:
            continue

        targets.append(
            HospitalRunTarget(
                regional_bureau=str(row["regional_bureau"]),
                medical_institution_code=str(row["medical_institution_code"]),
                institution_name=institution_name,
                address=str(row["address"] or ""),
                bed_count_text=bed_count_text,
                departments_text=str(row["departments_text"] or ""),
                facility_standard_count=facility_standard_count,
                classification=classification,
                recommended_action=recommended_action,
                included_in_default_run=included,
                warnings=warnings,
            )
        )
    return targets


def summarize_hospital_run_targets(
    conn: sqlite3.Connection,
) -> list[HospitalRunTargetSummary]:
    targets = list_hospital_run_targets(conn, include_excluded=True)
    grouped: dict[tuple[bool, str, str], int] = {}
    for target in targets:
        key = (
            target.included_in_default_run,
            target.classification,
            target.recommended_action,
        )
        grouped[key] = grouped.get(key, 0) + 1

    return [
        HospitalRunTargetSummary(
            included_in_default_run=included,
            classification=classification,
            recommended_action=recommended_action,
            count=count,
        )
        for (included, classification, recommended_action), count in sorted(
            grouped.items(),
            key=lambda item: (
                not item[0][0],
                item[0][1],
                item[0][2],
            ),
        )
    ]


def hospital_registry_quality_to_markdown(
    summaries: list[HospitalRegistryQualitySummary],
) -> str:
    rows = summaries + [_total_summary(summaries)]
    lines = [
        "# Hospital Registry Quality Summary",
        "",
        (
            "| Bureau | Registry Rows | Hospitals | Active Hospitals | "
            "Facility Institutions | Active Hospitals With Facility | "
            "Active Hospitals Without Facility |"
        ),
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for summary in rows:
        lines.append(
            "| "
            + " | ".join(
                (
                    summary.regional_bureau,
                    str(summary.registry_rows),
                    str(summary.hospital_rows),
                    str(summary.active_hospital_rows),
                    str(summary.facility_standard_institution_count),
                    str(summary.active_hospital_with_facility_standard_count),
                    str(summary.active_hospital_without_facility_standard_count),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def unmatched_active_hospitals_to_markdown(
    hospitals: list[UnmatchedActiveHospital],
) -> str:
    lines = [
        "# Unmatched Active Hospitals",
        "",
        (
            "| Bureau | Code | Name | Beds | Classification | Recommended Action | "
            "Same-Bureau Name Matches | Address |"
        ),
        "| --- | --- | --- | --- | --- | --- | ---: | --- |",
    ]
    for hospital in hospitals:
        lines.append(
            "| "
            + " | ".join(
                (
                    hospital.regional_bureau,
                    hospital.medical_institution_code,
                    _escape_markdown_table_cell(hospital.institution_name),
                    _escape_markdown_table_cell(hospital.bed_count_text),
                    hospital.classification,
                    hospital.recommended_action,
                    str(hospital.same_bureau_name_match_count),
                    _escape_markdown_table_cell(hospital.address),
                )
            )
            + " |"
        )
    lines.extend(("", f"Total: {len(hospitals)}"))
    return "\n".join(lines)


def hospital_run_targets_to_markdown(
    targets: list[HospitalRunTarget],
) -> str:
    default_count = sum(1 for target in targets if target.included_in_default_run)
    lines = [
        "# Hospital Run Targets",
        "",
        (
            "| Default | Bureau | Code | Name | Facility Standards | Classification | "
            "Recommended Action | Warnings | Beds | Address |"
        ),
        "| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
    ]
    for target in targets:
        lines.append(
            "| "
            + " | ".join(
                (
                    "yes" if target.included_in_default_run else "no",
                    target.regional_bureau,
                    target.medical_institution_code,
                    _escape_markdown_table_cell(target.institution_name),
                    str(target.facility_standard_count),
                    target.classification,
                    target.recommended_action,
                    ", ".join(target.warnings),
                    _escape_markdown_table_cell(target.bed_count_text),
                    _escape_markdown_table_cell(target.address),
                )
            )
            + " |"
        )
    lines.extend(("", f"Default run targets: {default_count}", f"Total rows: {len(targets)}"))
    return "\n".join(lines)


def hospital_run_target_summary_to_markdown(
    summaries: list[HospitalRunTargetSummary],
) -> str:
    total = sum(summary.count for summary in summaries)
    default_total = sum(summary.count for summary in summaries if summary.included_in_default_run)
    lines = [
        "# Hospital Run Target Summary",
        "",
        "| Default | Classification | Recommended Action | Count |",
        "| --- | --- | --- | ---: |",
    ]
    for summary in summaries:
        lines.append(
            "| "
            + " | ".join(
                (
                    "yes" if summary.included_in_default_run else "no",
                    summary.classification,
                    summary.recommended_action,
                    str(summary.count),
                )
            )
            + " |"
        )
    lines.extend(("", f"Default run targets: {default_total}", f"Total active hospitals: {total}"))
    return "\n".join(lines)


def _total_summary(
    summaries: list[HospitalRegistryQualitySummary],
) -> HospitalRegistryQualitySummary:
    return HospitalRegistryQualitySummary(
        regional_bureau="total",
        registry_rows=sum(summary.registry_rows for summary in summaries),
        hospital_rows=sum(summary.hospital_rows for summary in summaries),
        active_hospital_rows=sum(summary.active_hospital_rows for summary in summaries),
        facility_standard_institution_count=sum(
            summary.facility_standard_institution_count for summary in summaries
        ),
        active_hospital_with_facility_standard_count=sum(
            summary.active_hospital_with_facility_standard_count for summary in summaries
        ),
        active_hospital_without_facility_standard_count=sum(
            summary.active_hospital_without_facility_standard_count for summary in summaries
        ),
    )


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " / ")


def _classify_unmatched_active_hospital(
    *,
    institution_name: str,
    bed_count_text: str,
) -> tuple[str, str]:
    scope_review = _classify_hospital_scope_review(
        institution_name=institution_name,
        bed_count_text=bed_count_text,
    )
    if scope_review is not None:
        return scope_review
    if not _has_bed_count(bed_count_text):
        return "bed_count_missing_review", "needs_review"
    return "facility_standards_missing", "include_with_facility_warning"


def _classify_hospital_scope_review(
    *,
    institution_name: str,
    bed_count_text: str,
) -> tuple[str, str] | None:
    if "歯科大学" in institution_name or "歯学部" in institution_name:
        return "dental_hospital_scope_review", "exclude_from_default_medical_run"
    if "クリニック" in institution_name and not _has_bed_count(bed_count_text):
        return "clinic_named_registry_review", "exclude_from_default_medical_run"
    return None


def _has_bed_count(value: str) -> bool:
    return any(char.isdigit() for char in value) and any(
        token in value for token in ("一般", "療養", "精神", "結核", "感染", "病床")
    )
