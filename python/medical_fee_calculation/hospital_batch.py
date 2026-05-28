from __future__ import annotations

import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    ClaimContext,
    EncounterContext,
    MasterSourceContext,
    PatientContext,
)
from medical_fee_calculation.hospital_profile import get_hospital_profile
from medical_fee_calculation.hospital_quality import HospitalRunTarget, list_hospital_run_targets


@dataclass(frozen=True)
class HospitalProfileBatchResult:
    regional_bureau: str
    medical_institution_code: str
    institution_name: str
    target_included_in_default_run: bool
    profile_included_in_default_medical_run: bool | None
    target_classification: str
    profile_classification: str | None
    target_recommended_action: str
    profile_recommended_action: str | None
    target_facility_standard_count: int
    profile_facility_standard_count: int | None
    profile_dpc_hospital_coefficient_present: bool | None
    profile_dpc_hospital_group: str | None
    warnings: tuple[str, ...]
    status: str
    error: str | None = None

    def to_dict(self) -> dict[str, bool | int | str | tuple[str, ...] | None]:
        return {
            "regional_bureau": self.regional_bureau,
            "medical_institution_code": self.medical_institution_code,
            "institution_name": self.institution_name,
            "target_included_in_default_run": self.target_included_in_default_run,
            "profile_included_in_default_medical_run": (
                self.profile_included_in_default_medical_run
            ),
            "target_classification": self.target_classification,
            "profile_classification": self.profile_classification,
            "target_recommended_action": self.target_recommended_action,
            "profile_recommended_action": self.profile_recommended_action,
            "target_facility_standard_count": self.target_facility_standard_count,
            "profile_facility_standard_count": self.profile_facility_standard_count,
            "profile_dpc_hospital_coefficient_present": (
                self.profile_dpc_hospital_coefficient_present
            ),
            "profile_dpc_hospital_group": self.profile_dpc_hospital_group,
            "warnings": self.warnings,
            "status": self.status,
            "error": self.error,
        }


@dataclass(frozen=True)
class HospitalClaimRunContext:
    service_date: date
    regional_bureau: str
    medical_institution_code: str
    institution_name: str
    included_in_default_medical_run: bool
    default_run_classification: str | None
    default_run_recommended_action: str | None
    facility_standard_keys: tuple[str, ...]
    warnings: tuple[str, ...]
    is_outpatient: bool = True

    def to_claim_context(
        self,
        *,
        procedure_codes: tuple[str, ...] = (),
        patient_id: str | None = None,
        master_sources: MasterSourceContext | None = None,
    ) -> ClaimContext:
        return ClaimContext(
            patient=PatientContext(patient_id=patient_id),
            encounter=EncounterContext(
                service_date=self.service_date,
                medical_institution_code=self.medical_institution_code,
                regional_bureau=self.regional_bureau,
                is_outpatient=self.is_outpatient,
            ),
            procedure_codes=procedure_codes,
            master_sources=master_sources or MasterSourceContext(),
            facility_standard_keys=frozenset(self.facility_standard_keys),
        )

    def to_dict(self) -> dict[str, bool | list[str] | str | None]:
        return {
            "service_date": self.service_date.isoformat(),
            "regional_bureau": self.regional_bureau,
            "medical_institution_code": self.medical_institution_code,
            "institution_name": self.institution_name,
            "is_outpatient": self.is_outpatient,
            "included_in_default_medical_run": self.included_in_default_medical_run,
            "default_run_classification": self.default_run_classification,
            "default_run_recommended_action": self.default_run_recommended_action,
            "facility_standard_keys": list(self.facility_standard_keys),
            "warnings": list(self.warnings),
            "claim_context_template": {
                "patient": {"patient_id": None},
                "encounter": {
                    "service_date": self.service_date.isoformat(),
                    "regional_bureau": self.regional_bureau,
                    "medical_institution_code": self.medical_institution_code,
                    "is_outpatient": self.is_outpatient,
                },
                "procedure_codes": [],
                "facility_standard_keys": list(self.facility_standard_keys),
            },
        }


def smoke_hospital_run_targets(
    conn: sqlite3.Connection,
    *,
    service_date: date,
    include_excluded: bool = False,
) -> list[HospitalProfileBatchResult]:
    results: list[HospitalProfileBatchResult] = []
    for target in list_hospital_run_targets(conn, include_excluded=include_excluded):
        results.append(_smoke_hospital_run_target(conn, target, service_date))
    return results


def build_hospital_claim_run_contexts(
    conn: sqlite3.Connection,
    *,
    service_date: date,
    include_excluded: bool = False,
    is_outpatient: bool = True,
    limit: int | None = None,
) -> list[HospitalClaimRunContext]:
    contexts: list[HospitalClaimRunContext] = []
    for target in list_hospital_run_targets(conn, include_excluded=include_excluded):
        if limit is not None and len(contexts) >= limit:
            break
        profile = get_hospital_profile(
            conn,
            target.medical_institution_code,
            service_date,
            regional_bureau=target.regional_bureau,
        )
        contexts.append(
            HospitalClaimRunContext(
                service_date=service_date,
                regional_bureau=target.regional_bureau,
                medical_institution_code=target.medical_institution_code,
                institution_name=target.institution_name,
                included_in_default_medical_run=bool(profile.included_in_default_medical_run),
                default_run_classification=profile.default_run_classification,
                default_run_recommended_action=profile.default_run_recommended_action,
                facility_standard_keys=tuple(sorted(profile.facility_standard_keys)),
                warnings=profile.warnings,
                is_outpatient=is_outpatient,
            )
        )
    return contexts


def hospital_claim_run_contexts_to_markdown(
    contexts: list[HospitalClaimRunContext],
) -> str:
    classification_counts = Counter(
        context.default_run_classification or "unknown" for context in contexts
    )
    warning_count = sum(1 for context in contexts if context.warnings)
    lines = [
        "# Hospital Claim Run Contexts",
        "",
        "| Classification | Count |",
        "| --- | ---: |",
    ]
    for classification, count in sorted(classification_counts.items()):
        lines.append(f"| {classification} | {count} |")

    lines.extend(
        (
            "",
            "| Bureau | Code | Name | Classification | Facility Keys | Warnings |",
            "| --- | --- | --- | --- | ---: | --- |",
        )
    )
    for context in contexts:
        if not context.warnings:
            continue
        lines.append(
            "| "
            + " | ".join(
                (
                    context.regional_bureau,
                    context.medical_institution_code,
                    _escape_markdown_table_cell(context.institution_name),
                    context.default_run_classification or "",
                    str(len(context.facility_standard_keys)),
                    _escape_markdown_table_cell(", ".join(context.warnings)),
                )
            )
            + " |"
        )
    lines.extend(("", f"Total contexts: {len(contexts)}", f"Rows with warnings: {warning_count}"))
    return "\n".join(lines)


def hospital_profile_batch_results_to_markdown(
    results: list[HospitalProfileBatchResult],
) -> str:
    status_counts = Counter(result.status for result in results)
    classification_counts = Counter(
        (result.status, result.profile_classification or result.target_classification)
        for result in results
    )
    dpc_coefficient_counts = Counter(
        (
            "yes" if result.profile_dpc_hospital_coefficient_present else "no",
            result.profile_dpc_hospital_group or "",
        )
        for result in results
        if result.profile_dpc_hospital_coefficient_present is not None
    )
    rows_needing_attention = [
        result for result in results if result.status != "ok" or result.warnings
    ]

    lines = [
        "# Hospital Profile Batch Smoke",
        "",
        "| Status | Count |",
        "| --- | ---: |",
    ]
    for status, count in sorted(status_counts.items()):
        lines.append(f"| {status} | {count} |")

    lines.extend(("", "| Status | Classification | Count |", "| --- | --- | ---: |"))
    for (status, classification), count in sorted(classification_counts.items()):
        lines.append(f"| {status} | {classification} | {count} |")

    lines.extend(("", "| DPC Coefficient | Hospital Group | Count |", "| --- | --- | ---: |"))
    for (present, hospital_group), count in sorted(dpc_coefficient_counts.items()):
        lines.append(f"| {present} | {hospital_group} | {count} |")

    lines.extend(
        (
            "",
            "| Status | Bureau | Code | Name | Classification | Warnings | Error |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        )
    )
    for result in rows_needing_attention:
        lines.append(
            "| "
            + " | ".join(
                (
                    result.status,
                    result.regional_bureau,
                    result.medical_institution_code,
                    _escape_markdown_table_cell(result.institution_name),
                    result.profile_classification or result.target_classification,
                    _escape_markdown_table_cell(", ".join(result.warnings)),
                    _escape_markdown_table_cell(result.error or ""),
                )
            )
            + " |"
        )

    lines.extend(
        (
            "",
            f"Total targets: {len(results)}",
            f"OK: {status_counts.get('ok', 0)}",
            f"Non-OK: {len(results) - status_counts.get('ok', 0)}",
            f"Rows with warnings: {sum(1 for result in results if result.warnings)}",
        )
    )
    return "\n".join(lines)


def _smoke_hospital_run_target(
    conn: sqlite3.Connection,
    target: HospitalRunTarget,
    service_date: date,
) -> HospitalProfileBatchResult:
    try:
        profile = get_hospital_profile(
            conn,
            target.medical_institution_code,
            service_date,
            regional_bureau=target.regional_bureau,
        )
        issues = _profile_batch_issues(target, profile)
        status = "ok" if not issues else "mismatch"
        warnings = (*profile.warnings, *issues)
        return HospitalProfileBatchResult(
            regional_bureau=target.regional_bureau,
            medical_institution_code=target.medical_institution_code,
            institution_name=target.institution_name,
            target_included_in_default_run=target.included_in_default_run,
            profile_included_in_default_medical_run=profile.included_in_default_medical_run,
            target_classification=target.classification,
            profile_classification=profile.default_run_classification,
            target_recommended_action=target.recommended_action,
            profile_recommended_action=profile.default_run_recommended_action,
            target_facility_standard_count=target.facility_standard_count,
            profile_facility_standard_count=len(profile.facility_standards),
            profile_dpc_hospital_coefficient_present=(
                profile.dpc_hospital_coefficient is not None
            ),
            profile_dpc_hospital_group=(
                None
                if profile.dpc_hospital_coefficient is None
                else profile.dpc_hospital_coefficient.hospital_group
            ),
            warnings=warnings,
            status=status,
        )
    except Exception as exc:  # pragma: no cover - defensive batch boundary
        return HospitalProfileBatchResult(
            regional_bureau=target.regional_bureau,
            medical_institution_code=target.medical_institution_code,
            institution_name=target.institution_name,
            target_included_in_default_run=target.included_in_default_run,
            profile_included_in_default_medical_run=None,
            target_classification=target.classification,
            profile_classification=None,
            target_recommended_action=target.recommended_action,
            profile_recommended_action=None,
            target_facility_standard_count=target.facility_standard_count,
            profile_facility_standard_count=None,
            profile_dpc_hospital_coefficient_present=None,
            profile_dpc_hospital_group=None,
            warnings=(),
            status="error",
            error=str(exc),
        )


def _profile_batch_issues(target: HospitalRunTarget, profile: object) -> tuple[str, ...]:
    issues: list[str] = []
    if profile.included_in_default_medical_run != target.included_in_default_run:
        issues.append(
            "profile_included_mismatch:"
            f"target={target.included_in_default_run},"
            f"profile={profile.included_in_default_medical_run}"
        )
    if profile.default_run_classification != target.classification:
        issues.append(
            "profile_classification_mismatch:"
            f"target={target.classification},"
            f"profile={profile.default_run_classification}"
        )
    if profile.default_run_recommended_action != target.recommended_action:
        issues.append(
            "profile_action_mismatch:"
            f"target={target.recommended_action},"
            f"profile={profile.default_run_recommended_action}"
        )
    return tuple(issues)


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " / ")
