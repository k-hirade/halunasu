from __future__ import annotations

import csv
import io
import json
import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from medical_fee_calculation.claim_models import (
    CTEquipmentKind,
    CalculationLine,
    CalculationMessage,
    CalculationResult,
    ChargeInput,
    ClaimContext,
    ClaimItemStatus,
    ClaimHistoryContext,
    CommentInput,
    DataCompletenessContext,
    DpcOptionContext,
    EncounterContext,
    GenericNamePrescriptionAddOnKind,
    ImagingAcquisitionKind,
    ImagingKind,
    ImagingOrder,
    InjectionOptionContext,
    InjectionOrder,
    InjectionRouteKind,
    LabOptionContext,
    InpatientBasicFeeOptionContext,
    MasterSourceContext,
    MedicationDeliveryKind,
    MedicationDispensingKind,
    MedicationOptionContext,
    MedicationOrder,
    MedicationPrescriptionCategory,
    MRIEquipmentKind,
    OutpatientBasicFeeKind,
    OutpatientBasicFeeOptionContext,
    PatientContext,
    RadiographyDiagnosticKind,
    TreatmentAreaSizeKind,
    TreatmentKind,
    TreatmentOrder,
)
from medical_fee_calculation.electronic_rules import ProcedureHistoryEvent
from medical_fee_calculation.hospital_batch import build_hospital_claim_run_contexts
from medical_fee_calculation.lab_calculator import calculate_lab_claim_standardized


DEFAULT_NATIONWIDE_LAB_SMOKE_PROCEDURE_CODES = ("160000410", "160000310")

CLAIM_CONTEXT_FIELDS = frozenset(
    (
        "patient",
        "encounter",
        "procedure_codes",
        "drug_inputs",
        "medication_orders",
        "injection_drug_inputs",
        "injection_orders",
        "treatment_orders",
        "imaging_orders",
        "material_inputs",
        "comment_inputs",
        "master_sources",
        "history",
        "lab_options",
        "outpatient_basic",
        "medication",
        "injection",
        "inpatient_basic",
        "dpc",
        "data_completeness",
        "facility_standard_keys",
        "kizami_quantities",
    )
)
ENCOUNTER_FIELDS = frozenset(
    (
        "service_date",
        "medical_institution_code",
        "regional_bureau",
        "is_outpatient",
        "admission_date",
        "discharge_date",
    )
)
MASTER_SOURCE_FIELDS = (
    "medical_procedure_source_id",
    "drug_source_id",
    "material_source_id",
    "electronic_fee_source_id",
    "dpc_electronic_table_source_id",
    "dpc_hospital_coefficient_source_id",
    "comment_source_id",
    "registry_source_id",
    "facility_source_id",
)
CLAIM_BATCH_AUDIT_SUMMARY_FIELDS = (
    "scope",
    "regional_bureau",
    "medical_institution_code",
    "facility_standard_key",
    "status",
    "message_source",
    "message_status",
    "count",
)


@dataclass(frozen=True)
class ClaimBatchResult:
    record_id: str
    sequence_number: int
    status: str
    patient_id: str | None = None
    service_date: str | None = None
    regional_bureau: str | None = None
    medical_institution_code: str | None = None
    facility_standard_keys: tuple[str, ...] = ()
    result: CalculationResult | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result = self.result
        return {
            "record_id": self.record_id,
            "sequence_number": self.sequence_number,
            "status": self.status,
            "patient_id": self.patient_id,
            "service_date": self.service_date,
            "regional_bureau": self.regional_bureau,
            "medical_institution_code": self.medical_institution_code,
            "facility_standard_keys": list(self.facility_standard_keys),
            "input_codes": [] if result is None else list(result.input_codes),
            "candidate_codes": [] if result is None else list(result.candidate_codes),
            "total_confirmed_points": None if result is None else result.total_confirmed_points,
            "total_candidate_points": None if result is None else result.total_candidate_points,
            "total_points": None if result is None else result.total_points,
            "line_count": 0 if result is None else len(result.lines),
            "message_count": 0 if result is None else len(result.messages),
            "message_status_counts": (
                {}
                if result is None
                else dict(Counter(message.status.value for message in result.messages))
            ),
            "lines": [] if result is None else [_line_to_dict(line) for line in result.lines],
            "messages": (
                [] if result is None else [_message_to_dict(message) for message in result.messages]
            ),
            "error": self.error,
        }


@dataclass(frozen=True)
class GoldEvaluationResult:
    batch_result: ClaimBatchResult
    expected_total_points: float | None = None
    expected_candidate_codes: tuple[str, ...] = ()
    expected_status: str | None = None
    point_tolerance: float = 0.001

    @property
    def actual_total_points(self) -> float | None:
        return None if self.batch_result.result is None else self.batch_result.result.total_points

    @property
    def actual_candidate_codes(self) -> tuple[str, ...]:
        return () if self.batch_result.result is None else self.batch_result.result.candidate_codes

    @property
    def point_delta(self) -> float | None:
        if self.expected_total_points is None or self.actual_total_points is None:
            return None
        return self.actual_total_points - self.expected_total_points

    @property
    def point_verdict(self) -> str:
        if self.batch_result.error is not None:
            return "error"
        if self.point_delta is None:
            return "unlabeled"
        if abs(self.point_delta) <= self.point_tolerance:
            return "match"
        return "over" if self.point_delta > 0 else "under"

    @property
    def missing_expected_codes(self) -> tuple[str, ...]:
        actual = set(self.actual_candidate_codes)
        return tuple(code for code in self.expected_candidate_codes if code not in actual)

    @property
    def extra_actual_codes(self) -> tuple[str, ...]:
        if not self.expected_candidate_codes:
            return ()
        expected = set(self.expected_candidate_codes)
        return tuple(code for code in self.actual_candidate_codes if code not in expected)

    @property
    def code_verdict(self) -> str:
        if self.batch_result.error is not None:
            return "error"
        if not self.expected_candidate_codes:
            return "unlabeled"
        if self.missing_expected_codes or self.extra_actual_codes:
            return "mismatch"
        return "match"

    @property
    def overall_verdict(self) -> str:
        if self.batch_result.error is not None:
            return "error"
        if self.expected_status is not None and self.expected_status != self.batch_result.status:
            return "status_mismatch"
        if self.expected_status is not None and self.batch_result.status != "ok":
            if self.point_verdict in {"over", "under"}:
                return self.point_verdict
            if self.code_verdict == "mismatch":
                return "code_mismatch"
            return "match"
        if self.batch_result.status != "ok":
            return "needs_review"
        if self.point_verdict in {"over", "under"}:
            return self.point_verdict
        if self.code_verdict == "mismatch":
            return "code_mismatch"
        if self.point_verdict == "unlabeled" and self.code_verdict == "unlabeled":
            return "unlabeled"
        return "match"

    def to_dict(self) -> dict[str, Any]:
        result = self.batch_result.result
        message_sources = Counter(
            message.source for message in (() if result is None else result.messages)
        )
        return {
            "record_id": self.batch_result.record_id,
            "sequence_number": self.batch_result.sequence_number,
            "patient_id": self.batch_result.patient_id,
            "service_date": self.batch_result.service_date,
            "regional_bureau": self.batch_result.regional_bureau,
            "medical_institution_code": self.batch_result.medical_institution_code,
            "facility_standard_keys": list(self.batch_result.facility_standard_keys),
            "status": self.batch_result.status,
            "expected_status": self.expected_status,
            "overall_verdict": self.overall_verdict,
            "point_verdict": self.point_verdict,
            "code_verdict": self.code_verdict,
            "expected_total_points": self.expected_total_points,
            "actual_total_points": self.actual_total_points,
            "point_delta": self.point_delta,
            "point_tolerance": self.point_tolerance,
            "expected_candidate_codes": list(self.expected_candidate_codes),
            "actual_candidate_codes": list(self.actual_candidate_codes),
            "missing_expected_codes": list(self.missing_expected_codes),
            "extra_actual_codes": list(self.extra_actual_codes),
            "message_count": 0 if result is None else len(result.messages),
            "message_sources": dict(message_sources),
            "error": self.batch_result.error,
        }


def run_outpatient_lab_claim_batch(
    conn: sqlite3.Connection,
    input_path: str | Path,
    *,
    default_master_sources: MasterSourceContext | None = None,
    auto_master_sources: bool = True,
    limit: int | None = None,
) -> list[ClaimBatchResult]:
    results: list[ClaimBatchResult] = []
    for sequence_number, payload in _iter_jsonl(input_path):
        if limit is not None and len(results) >= limit:
            break
        results.append(
            run_outpatient_lab_claim_payload(
                conn,
                payload,
                sequence_number=sequence_number,
                default_master_sources=default_master_sources,
                auto_master_sources=auto_master_sources,
            )
        )
    return results


def run_outpatient_lab_claim_payloads(
    conn: sqlite3.Connection,
    payloads: tuple[dict[str, Any], ...] | list[dict[str, Any]],
    *,
    default_master_sources: MasterSourceContext | None = None,
    auto_master_sources: bool = True,
    limit: int | None = None,
) -> list[ClaimBatchResult]:
    results: list[ClaimBatchResult] = []
    for sequence_number, payload in enumerate(payloads, start=1):
        if limit is not None and len(results) >= limit:
            break
        results.append(
            run_outpatient_lab_claim_payload(
                conn,
                payload,
                sequence_number=sequence_number,
                default_master_sources=default_master_sources,
                auto_master_sources=auto_master_sources,
            )
        )
    return results


def run_outpatient_lab_claim_payload(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    *,
    sequence_number: int,
    default_master_sources: MasterSourceContext | None = None,
    auto_master_sources: bool = True,
) -> ClaimBatchResult:
    record_id = _record_id(payload, sequence_number)
    try:
        claim_context = parse_claim_context_payload(
            payload,
            conn=conn if auto_master_sources else None,
            default_master_sources=default_master_sources,
        )
        calculation_result = calculate_lab_claim_standardized(conn, claim_context)
        return ClaimBatchResult(
            record_id=record_id,
            sequence_number=sequence_number,
            status=_result_status(calculation_result),
            patient_id=claim_context.patient.patient_id,
            service_date=claim_context.encounter.service_date.isoformat(),
            regional_bureau=claim_context.encounter.regional_bureau,
            medical_institution_code=claim_context.encounter.medical_institution_code,
            facility_standard_keys=_claim_context_facility_standard_keys(claim_context),
            result=calculation_result,
        )
    except Exception as exc:  # noqa: BLE001 - keep batch execution row-local.
        return ClaimBatchResult(
            record_id=record_id,
            sequence_number=sequence_number,
            status="error",
            error=str(exc),
        )


def run_gold_outpatient_lab_claim_evaluation(
    conn: sqlite3.Connection,
    input_path: str | Path,
    *,
    default_master_sources: MasterSourceContext | None = None,
    auto_master_sources: bool = True,
    limit: int | None = None,
    point_tolerance: float = 0.001,
) -> list[GoldEvaluationResult]:
    results: list[GoldEvaluationResult] = []
    for sequence_number, payload in _iter_jsonl(input_path):
        if limit is not None and len(results) >= limit:
            break
        batch_result = run_outpatient_lab_claim_payload(
            conn,
            payload,
            sequence_number=sequence_number,
            default_master_sources=default_master_sources,
            auto_master_sources=auto_master_sources,
        )
        results.append(
            GoldEvaluationResult(
                batch_result=batch_result,
                expected_total_points=_gold_expected_total_points(payload),
                expected_candidate_codes=_gold_expected_candidate_codes(payload),
                expected_status=_gold_expected_status(payload),
                point_tolerance=point_tolerance,
            )
        )
    return results


def run_nationwide_outpatient_lab_smoke(
    conn: sqlite3.Connection,
    *,
    service_date: date,
    procedure_codes: tuple[str, ...] = DEFAULT_NATIONWIDE_LAB_SMOKE_PROCEDURE_CODES,
    collection_fee_inputs: tuple[str, ...] = (),
    comment_inputs: tuple[CommentInput, ...] = (),
    lab_management_facility_missing_policy: str = "ignore",
    include_excluded: bool = False,
    default_master_sources: MasterSourceContext | None = None,
    auto_master_sources: bool = True,
    limit: int | None = None,
) -> list[ClaimBatchResult]:
    results: list[ClaimBatchResult] = []
    contexts = build_hospital_claim_run_contexts(
        conn,
        service_date=service_date,
        include_excluded=include_excluded,
        is_outpatient=True,
        limit=limit,
    )
    master_source_cache: dict[str | None, MasterSourceContext] = {}
    for sequence_number, context in enumerate(contexts, start=1):
        record_id = (
            f"{context.regional_bureau}|{context.medical_institution_code}|"
            f"{service_date.isoformat()}|lab-smoke"
        )
        payload = context.to_dict()
        payload["record_id"] = record_id
        payload["patient"] = {
            "patient_id": f"smoke-{context.regional_bureau}-{context.medical_institution_code}"
        }
        payload["procedure_codes"] = list(procedure_codes)
        if comment_inputs:
            payload["comment_inputs"] = [
                _comment_input_to_payload(comment_input) for comment_input in comment_inputs
            ]
        payload["lab_options"] = {
            "outpatient_rapid_lab_same_day_result_explained": True,
            "outpatient_rapid_lab_written_information_provided": True,
            "outpatient_rapid_lab_result_based_care_provided": True,
            "lab_management_facility_missing_policy": lab_management_facility_missing_policy,
        }
        if collection_fee_inputs:
            payload["lab_options"]["collection_fee_inputs"] = list(collection_fee_inputs)
        try:
            resolved_master_sources = default_master_sources
            parse_conn = conn if auto_master_sources else None
            if auto_master_sources:
                cache_key = context.regional_bureau
                if cache_key not in master_source_cache:
                    master_source_cache[cache_key] = default_master_sources_from_db(
                        conn,
                        service_date=service_date,
                        regional_bureau=context.regional_bureau,
                        overrides=default_master_sources,
                    )
                resolved_master_sources = master_source_cache[cache_key]
                parse_conn = None
            claim_context = parse_claim_context_payload(
                payload,
                conn=parse_conn,
                default_master_sources=resolved_master_sources,
            )
            calculation_result = calculate_lab_claim_standardized(conn, claim_context)
            results.append(
                ClaimBatchResult(
                    record_id=record_id,
                    sequence_number=sequence_number,
                    status=_result_status(calculation_result),
                    patient_id=claim_context.patient.patient_id,
                    service_date=claim_context.encounter.service_date.isoformat(),
                    regional_bureau=claim_context.encounter.regional_bureau,
                    medical_institution_code=claim_context.encounter.medical_institution_code,
                    facility_standard_keys=_claim_context_facility_standard_keys(claim_context),
                    result=calculation_result,
                )
            )
        except Exception as exc:  # noqa: BLE001 - keep smoke execution row-local.
            results.append(
                ClaimBatchResult(
                    record_id=record_id,
                    sequence_number=sequence_number,
                    status="error",
                    patient_id=payload["patient"]["patient_id"],
                    service_date=service_date.isoformat(),
                    regional_bureau=context.regional_bureau,
                    medical_institution_code=context.medical_institution_code,
                    error=str(exc),
                )
            )
    return results


def parse_claim_context_payload(
    payload: dict[str, Any],
    *,
    conn: sqlite3.Connection | None = None,
    default_master_sources: MasterSourceContext | None = None,
) -> ClaimContext:
    merged = _merged_claim_context_payload(payload)
    encounter = _parse_encounter(_dict_value(merged, "encounter"))
    master_sources = _parse_master_sources(
        _dict_value(merged, "master_sources"),
        default_master_sources=default_master_sources,
        conn=conn,
        service_date=encounter.service_date,
        regional_bureau=encounter.regional_bureau,
    )
    return ClaimContext(
        patient=_parse_patient(_dict_value(merged, "patient")),
        encounter=encounter,
        procedure_codes=_string_tuple(merged.get("procedure_codes")),
        drug_inputs=_parse_charge_inputs(merged.get("drug_inputs")),
        medication_orders=_parse_medication_orders(merged.get("medication_orders")),
        injection_drug_inputs=_parse_charge_inputs(merged.get("injection_drug_inputs")),
        injection_orders=_parse_injection_orders(merged.get("injection_orders")),
        treatment_orders=_parse_treatment_orders(merged.get("treatment_orders")),
        imaging_orders=_parse_imaging_orders(merged.get("imaging_orders")),
        material_inputs=_parse_charge_inputs(merged.get("material_inputs")),
        comment_inputs=_parse_comment_inputs(merged.get("comment_inputs")),
        master_sources=master_sources,
        history=_parse_history(_dict_value(merged, "history")),
        lab_options=_parse_lab_options(_dict_value(merged, "lab_options")),
        outpatient_basic=_parse_outpatient_basic(_dict_value(merged, "outpatient_basic")),
        medication=_parse_medication_options(_dict_value(merged, "medication")),
        injection=_parse_injection_options(_dict_value(merged, "injection")),
        inpatient_basic=_parse_inpatient_basic(_dict_value(merged, "inpatient_basic")),
        dpc=_parse_dpc_options(_dict_value(merged, "dpc")),
        data_completeness=_parse_data_completeness(_dict_value(merged, "data_completeness")),
        facility_standard_keys=_optional_frozenset(merged.get("facility_standard_keys")),
        kizami_quantities=_parse_kizami_quantities(merged.get("kizami_quantities")),
    )


def _parse_kizami_quantities(value: Any) -> tuple[tuple[str, float], ...]:
    if not isinstance(value, dict):
        return ()
    result: list[tuple[str, float]] = []
    for code, quantity in value.items():
        code_text = str(code or "").strip()
        try:
            quantity_value = float(quantity)
        except (TypeError, ValueError):
            continue
        if code_text and quantity_value > 0:
            result.append((code_text, quantity_value))
    return tuple(sorted(result))


def _claim_context_facility_standard_keys(claim_context: ClaimContext) -> tuple[str, ...]:
    if claim_context.facility_standard_keys is not None:
        keys = claim_context.facility_standard_keys
    elif claim_context.hospital_profile is not None:
        keys = claim_context.hospital_profile.facility_standard_keys
    else:
        keys = frozenset()
    return tuple(sorted(str(key).strip() for key in keys if str(key).strip()))


def claim_batch_results_to_markdown(results: list[ClaimBatchResult]) -> str:
    status_counts = Counter(result.status for result in results)
    bureau_status_counts: Counter[tuple[str, str]] = Counter()
    message_status_counts: Counter[str] = Counter()
    line_status_counts: Counter[str] = Counter()
    message_source_status_counts: Counter[tuple[str, str]] = Counter()
    bureau_message_source_status_counts: Counter[tuple[str, str, str]] = Counter()
    hospital_message_source_status_counts: Counter[tuple[str, str, str, str]] = Counter()
    message_text_counts: Counter[tuple[str, str | None, str]] = Counter()
    for result in results:
        bureau = result.regional_bureau or "unknown"
        hospital_code = result.medical_institution_code or "unknown"
        bureau_status_counts.update(((bureau, result.status),))
        if result.error is not None:
            bureau_message_source_status_counts.update(((bureau, "error", "error"),))
            hospital_message_source_status_counts.update(
                ((bureau, hospital_code, "error", "error"),)
            )
        if result.result is None:
            continue
        line_status_counts.update(line.status.value for line in result.result.lines)
        message_status_counts.update(message.status.value for message in result.result.messages)
        message_source_status_counts.update(
            (message.source, message.status.value) for message in result.result.messages
        )
        bureau_message_source_status_counts.update(
            (bureau, message.source, message.status.value)
            for message in result.result.messages
        )
        hospital_message_source_status_counts.update(
            (bureau, hospital_code, message.source, message.status.value)
            for message in result.result.messages
        )
        message_text_counts.update(
            (message.source, message.code, message.message) for message in result.result.messages
        )

    lines = [
        "# Claim Batch",
        "",
        "| Status | Count |",
        "| --- | ---: |",
    ]
    for status, count in sorted(status_counts.items()):
        lines.append(f"| {status} | {count} |")

    lines.extend(("", "| Message Status | Count |", "| --- | ---: |"))
    if message_status_counts:
        for status, count in sorted(message_status_counts.items()):
            lines.append(f"| {status} | {count} |")
    else:
        lines.append("| none | 0 |")

    lines.extend(("", "| Line Status | Count |", "| --- | ---: |"))
    if line_status_counts:
        for status, count in sorted(line_status_counts.items()):
            lines.append(f"| {status} | {count} |")
    else:
        lines.append("| none | 0 |")

    lines.extend(("", "| Message Source | Status | Count |", "| --- | --- | ---: |"))
    if message_source_status_counts:
        for (source, status), count in sorted(message_source_status_counts.items()):
            lines.append(f"| {source} | {status} | {count} |")
    else:
        lines.append("| none | none | 0 |")

    lines.extend(("", "| Bureau | Status | Count |", "| --- | --- | ---: |"))
    if bureau_status_counts:
        for (bureau, status), count in sorted(bureau_status_counts.items()):
            lines.append(f"| {bureau} | {status} | {count} |")
    else:
        lines.append("| none | none | 0 |")

    lines.extend(
        (
            "",
            "| Bureau | Message Source | Status | Count |",
            "| --- | --- | --- | ---: |",
        )
    )
    if bureau_message_source_status_counts:
        for (bureau, source, status), count in sorted(bureau_message_source_status_counts.items()):
            lines.append(f"| {bureau} | {source} | {status} | {count} |")
    else:
        lines.append("| none | none | none | 0 |")

    lines.extend(
        (
            "",
            "| Bureau | Code | Message Source | Status | Count |",
            "| --- | --- | --- | --- | ---: |",
        )
    )
    if hospital_message_source_status_counts:
        for (
            bureau,
            hospital_code,
            source,
            status,
        ), count in hospital_message_source_status_counts.most_common(50):
            lines.append(
                f"| {bureau} | {hospital_code} | {source} | {status} | {count} |"
            )
    else:
        lines.append("| none | none | none | none | 0 |")

    lines.extend(("", "| Message Source | Code | Message | Count |", "| --- | --- | --- | ---: |"))
    if message_text_counts:
        for (source, code, message), count in message_text_counts.most_common(20):
            lines.append(
                "| "
                + " | ".join(
                    (
                        source,
                        code or "",
                        _escape_markdown_table_cell(message),
                        str(count),
                    )
                )
                + " |"
            )
    else:
        lines.append("| none |  |  | 0 |")

    attention_rows = [
        result for result in results if result.status != "ok" or result.error is not None
    ]
    lines.extend(
        (
            "",
            "| Status | Record | Bureau | Code | Patient | Service Date | Messages | Message Sources | Error |",
            "| --- | --- | --- | --- | --- | --- | ---: | --- | --- |",
        )
    )
    for result in attention_rows:
        source_counts = Counter(
            message.source for message in (() if result.result is None else result.result.messages)
        )
        lines.append(
            "| "
            + " | ".join(
                (
                    result.status,
                    _escape_markdown_table_cell(result.record_id),
                    result.regional_bureau or "",
                    result.medical_institution_code or "",
                    result.patient_id or "",
                    result.service_date or "",
                    "0" if result.result is None else str(len(result.result.messages)),
                    _escape_markdown_table_cell(
                        ", ".join(f"{source}:{count}" for source, count in sorted(source_counts.items()))
                    ),
                    _escape_markdown_table_cell(result.error or ""),
                )
            )
            + " |"
        )

    total_points = sum(result.result.total_points for result in results if result.result is not None)
    lines.extend(("", f"Total records: {len(results)}", f"Total points: {total_points:g}"))
    return "\n".join(lines)


def claim_batch_results_to_tsv(results: list[ClaimBatchResult]) -> str:
    lines = [
        (
            "status\trecord_id\tsequence_number\tpatient_id\tservice_date\tregional_bureau\t"
            "medical_institution_code\tfacility_standard_keys\tinput_codes\tcandidate_codes\t"
            "total_confirmed_points\t"
            "total_candidate_points\ttotal_points\tline_count\tmessage_count\terror"
        )
    ]
    for result in results:
        calculation_result = result.result
        lines.append(
            "\t".join(
                (
                    result.status,
                    result.record_id,
                    str(result.sequence_number),
                    result.patient_id or "",
                    result.service_date or "",
                    result.regional_bureau or "",
                    result.medical_institution_code or "",
                    ",".join(result.facility_standard_keys),
                    "" if calculation_result is None else ",".join(calculation_result.input_codes),
                    "" if calculation_result is None else ",".join(calculation_result.candidate_codes),
                    "" if calculation_result is None else f"{calculation_result.total_confirmed_points:g}",
                    "" if calculation_result is None else f"{calculation_result.total_candidate_points:g}",
                    "" if calculation_result is None else f"{calculation_result.total_points:g}",
                    "0" if calculation_result is None else str(len(calculation_result.lines)),
                    "0" if calculation_result is None else str(len(calculation_result.messages)),
                    result.error or "",
                )
            )
        )
    return "\n".join(lines)


def claim_batch_audit_summary_rows(results: list[ClaimBatchResult]) -> tuple[dict[str, Any], ...]:
    status_counts: Counter[str] = Counter()
    bureau_status_counts: Counter[tuple[str, str]] = Counter()
    hospital_status_counts: Counter[tuple[str, str, str]] = Counter()
    facility_standard_status_counts: Counter[tuple[str, str]] = Counter()
    message_source_status_counts: Counter[tuple[str, str]] = Counter()
    bureau_message_source_status_counts: Counter[tuple[str, str, str]] = Counter()
    hospital_message_source_status_counts: Counter[tuple[str, str, str, str]] = Counter()
    facility_standard_message_source_status_counts: Counter[tuple[str, str, str]] = Counter()

    for result in results:
        bureau = result.regional_bureau or "unknown"
        hospital_code = result.medical_institution_code or "unknown"
        facility_standard_keys = result.facility_standard_keys or ("none",)

        status_counts.update((result.status,))
        bureau_status_counts.update(((bureau, result.status),))
        hospital_status_counts.update(((bureau, hospital_code, result.status),))
        facility_standard_status_counts.update(
            (facility_standard_key, result.status)
            for facility_standard_key in facility_standard_keys
        )

        if result.error is not None:
            _update_audit_message_counters(
                bureau=bureau,
                hospital_code=hospital_code,
                facility_standard_keys=facility_standard_keys,
                message_source="error",
                message_status="error",
                message_source_status_counts=message_source_status_counts,
                bureau_message_source_status_counts=bureau_message_source_status_counts,
                hospital_message_source_status_counts=hospital_message_source_status_counts,
                facility_standard_message_source_status_counts=facility_standard_message_source_status_counts,
            )

        if result.result is None:
            continue
        for message in result.result.messages:
            _update_audit_message_counters(
                bureau=bureau,
                hospital_code=hospital_code,
                facility_standard_keys=facility_standard_keys,
                message_source=message.source,
                message_status=message.status.value,
                message_source_status_counts=message_source_status_counts,
                bureau_message_source_status_counts=bureau_message_source_status_counts,
                hospital_message_source_status_counts=hospital_message_source_status_counts,
                facility_standard_message_source_status_counts=facility_standard_message_source_status_counts,
            )

    rows: list[dict[str, Any]] = []
    rows.extend(
        _audit_summary_row(scope="overall_status", status=status, count=count)
        for status, count in sorted(status_counts.items())
    )
    rows.extend(
        _audit_summary_row(
            scope="bureau_status",
            regional_bureau=bureau,
            status=status,
            count=count,
        )
        for (bureau, status), count in sorted(bureau_status_counts.items())
    )
    rows.extend(
        _audit_summary_row(
            scope="hospital_status",
            regional_bureau=bureau,
            medical_institution_code=hospital_code,
            status=status,
            count=count,
        )
        for (bureau, hospital_code, status), count in sorted(hospital_status_counts.items())
    )
    rows.extend(
        _audit_summary_row(
            scope="facility_standard_status",
            facility_standard_key=facility_standard_key,
            status=status,
            count=count,
        )
        for (facility_standard_key, status), count in sorted(
            facility_standard_status_counts.items()
        )
    )
    rows.extend(
        _audit_summary_row(
            scope="message_source_status",
            message_source=source,
            message_status=status,
            count=count,
        )
        for (source, status), count in sorted(message_source_status_counts.items())
    )
    rows.extend(
        _audit_summary_row(
            scope="bureau_message_source_status",
            regional_bureau=bureau,
            message_source=source,
            message_status=status,
            count=count,
        )
        for (bureau, source, status), count in sorted(
            bureau_message_source_status_counts.items()
        )
    )
    rows.extend(
        _audit_summary_row(
            scope="hospital_message_source_status",
            regional_bureau=bureau,
            medical_institution_code=hospital_code,
            message_source=source,
            message_status=status,
            count=count,
        )
        for (bureau, hospital_code, source, status), count in sorted(
            hospital_message_source_status_counts.items()
        )
    )
    rows.extend(
        _audit_summary_row(
            scope="facility_standard_message_source_status",
            facility_standard_key=facility_standard_key,
            message_source=source,
            message_status=status,
            count=count,
        )
        for (facility_standard_key, source, status), count in sorted(
            facility_standard_message_source_status_counts.items()
        )
    )
    return tuple(rows)


def claim_batch_audit_summary_to_csv(
    rows: tuple[dict[str, Any], ...] | list[dict[str, Any]],
) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=CLAIM_BATCH_AUDIT_SUMMARY_FIELDS,
        lineterminator="\n",
    )
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {field: row.get(field, "") for field in CLAIM_BATCH_AUDIT_SUMMARY_FIELDS}
        )
    return output.getvalue()


def claim_batch_audit_summary_to_json(
    rows: tuple[dict[str, Any], ...] | list[dict[str, Any]],
) -> str:
    return json.dumps(list(rows), ensure_ascii=False, indent=2)


def claim_batch_audit_summary_to_tsv(
    rows: tuple[dict[str, Any], ...] | list[dict[str, Any]],
) -> str:
    lines = ["\t".join(CLAIM_BATCH_AUDIT_SUMMARY_FIELDS)]
    for row in rows:
        lines.append(
            "\t".join(str(row.get(field, "")) for field in CLAIM_BATCH_AUDIT_SUMMARY_FIELDS)
        )
    return "\n".join(lines)


GOLD_EVALUATION_FIELDS = (
    "record_id",
    "sequence_number",
    "patient_id",
    "service_date",
    "regional_bureau",
    "medical_institution_code",
    "facility_standard_keys",
    "status",
    "expected_status",
    "overall_verdict",
    "point_verdict",
    "code_verdict",
    "expected_total_points",
    "actual_total_points",
    "point_delta",
    "expected_candidate_codes",
    "actual_candidate_codes",
    "missing_expected_codes",
    "extra_actual_codes",
    "message_count",
    "message_sources",
    "error",
)
GOLD_DIFFERENCE_CLASSIFICATION_FIELDS = (
    "record_id",
    "sequence_number",
    "patient_id",
    "service_date",
    "regional_bureau",
    "medical_institution_code",
    "status",
    "expected_status",
    "overall_verdict",
    "point_delta",
    "classification",
    "feedback_target",
    "priority",
    "recommended_action",
    "reason",
    "expected_total_points",
    "actual_total_points",
    "missing_expected_codes",
    "extra_actual_codes",
    "message_sources",
    "error",
)
GOLD_IMPROVEMENT_BACKLOG_FIELDS = (
    "priority",
    "feedback_target",
    "classification",
    "recommended_action",
    "count",
    "sample_records",
    "sample_missing_expected_codes",
    "sample_extra_actual_codes",
    "sample_message_sources",
    "sample_reasons",
)
GOLD_IMPROVEMENT_ACTION_PLAN_FIELDS = (
    "rank",
    "owner",
    "priority",
    "feedback_target",
    "classification",
    "count",
    "recommended_action",
    "implementation_step",
    "acceptance_gate",
    "sample_records",
    "sample_missing_expected_codes",
    "sample_extra_actual_codes",
    "sample_message_sources",
    "sample_reasons",
)


@dataclass(frozen=True)
class _GoldDifferenceClassification:
    classification: str
    feedback_target: str
    priority: str
    recommended_action: str
    reason: str


@dataclass(frozen=True)
class _GoldActionGuidance:
    owner: str
    implementation_step: str
    acceptance_gate: str


def gold_evaluation_results_to_markdown(results: list[GoldEvaluationResult]) -> str:
    overall_counts = Counter(result.overall_verdict for result in results)
    point_counts = Counter(result.point_verdict for result in results)
    code_counts = Counter(result.code_verdict for result in results)
    lines = [
        "# Gold Claim Evaluation",
        "",
        "| Overall Verdict | Count |",
        "| --- | ---: |",
    ]
    for verdict, count in sorted(overall_counts.items()):
        lines.append(f"| {verdict} | {count} |")

    lines.extend(("", "| Point Verdict | Count |", "| --- | ---: |"))
    for verdict, count in sorted(point_counts.items()):
        lines.append(f"| {verdict} | {count} |")

    lines.extend(("", "| Code Verdict | Count |", "| --- | ---: |"))
    for verdict, count in sorted(code_counts.items()):
        lines.append(f"| {verdict} | {count} |")

    attention = [result for result in results if result.overall_verdict != "match"]
    lines.extend(
        (
            "",
            "| Verdict | Record | Status | Expected Points | Actual Points | Delta | Missing Codes | Extra Codes | Messages | Error |",
            "| --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- |",
        )
    )
    for result in attention[:100]:
        data = result.to_dict()
        lines.append(
            "| "
            + " | ".join(
                (
                    result.overall_verdict,
                    _escape_markdown_table_cell(result.batch_result.record_id),
                    result.batch_result.status,
                    _number_cell(result.expected_total_points),
                    _number_cell(result.actual_total_points),
                    _number_cell(result.point_delta),
                    _escape_markdown_table_cell(",".join(result.missing_expected_codes)),
                    _escape_markdown_table_cell(",".join(result.extra_actual_codes)),
                    str(data["message_count"]),
                    _escape_markdown_table_cell(result.batch_result.error or ""),
                )
            )
            + " |"
        )

    lines.extend(("", f"Total records: {len(results)}"))
    return "\n".join(lines)


def gold_evaluation_results_to_csv(results: list[GoldEvaluationResult]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=GOLD_EVALUATION_FIELDS, lineterminator="\n")
    writer.writeheader()
    for result in results:
        writer.writerow(_gold_evaluation_row(result))
    return output.getvalue()


def gold_evaluation_results_to_tsv(results: list[GoldEvaluationResult]) -> str:
    lines = ["\t".join(GOLD_EVALUATION_FIELDS)]
    for result in results:
        row = _gold_evaluation_row(result)
        lines.append("\t".join(str(row.get(field, "")) for field in GOLD_EVALUATION_FIELDS))
    return "\n".join(lines)


def gold_evaluation_results_to_json(results: list[GoldEvaluationResult]) -> str:
    return json.dumps([result.to_dict() for result in results], ensure_ascii=False, indent=2)


def gold_evaluation_results_to_jsonl(results: list[GoldEvaluationResult]) -> str:
    output = "\n".join(
        json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
        for result in results
    )
    if output:
        output += "\n"
    return output


def gold_difference_classification_rows(
    results: list[GoldEvaluationResult],
) -> tuple[dict[str, Any], ...]:
    return tuple(_gold_difference_classification_row(result) for result in results)


def gold_difference_classification_to_markdown(results: list[GoldEvaluationResult]) -> str:
    rows = gold_difference_classification_rows(results)
    classification_counts = Counter(str(row["classification"]) for row in rows)
    target_counts = Counter(str(row["feedback_target"]) for row in rows)
    priority_counts = Counter(str(row["priority"]) for row in rows)
    lines = [
        "# Gold Difference Classification",
        "",
        "| Classification | Count |",
        "| --- | ---: |",
    ]
    for classification, count in sorted(classification_counts.items()):
        lines.append(f"| {classification} | {count} |")

    lines.extend(("", "| Feedback Target | Count |", "| --- | ---: |"))
    for target, count in sorted(target_counts.items()):
        lines.append(f"| {target} | {count} |")

    lines.extend(("", "| Priority | Count |", "| --- | ---: |"))
    for priority, count in sorted(priority_counts.items()):
        lines.append(f"| {priority} | {count} |")

    attention = [row for row in rows if row["classification"] != "match"]
    lines.extend(
        (
            "",
            "| Priority | Classification | Target | Record | Verdict | Status | Delta | Missing Codes | Extra Codes | Message Sources | Recommended Action | Reason |",
            "| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
        )
    )
    for row in attention[:100]:
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(str(row["priority"])),
                    _escape_markdown_table_cell(str(row["classification"])),
                    _escape_markdown_table_cell(str(row["feedback_target"])),
                    _escape_markdown_table_cell(str(row["record_id"])),
                    _escape_markdown_table_cell(str(row["overall_verdict"])),
                    _escape_markdown_table_cell(str(row["status"])),
                    _classification_number_cell(row["point_delta"]),
                    _escape_markdown_table_cell(str(row["missing_expected_codes"])),
                    _escape_markdown_table_cell(str(row["extra_actual_codes"])),
                    _escape_markdown_table_cell(str(row["message_sources"])),
                    _escape_markdown_table_cell(str(row["recommended_action"])),
                    _escape_markdown_table_cell(str(row["reason"])),
                )
            )
            + " |"
        )

    lines.extend(("", f"Total records: {len(results)}"))
    return "\n".join(lines)


def gold_difference_classification_to_csv(results: list[GoldEvaluationResult]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=GOLD_DIFFERENCE_CLASSIFICATION_FIELDS,
        lineterminator="\n",
    )
    writer.writeheader()
    for row in gold_difference_classification_rows(results):
        writer.writerow(row)
    return output.getvalue()


def gold_difference_classification_to_tsv(results: list[GoldEvaluationResult]) -> str:
    lines = ["\t".join(GOLD_DIFFERENCE_CLASSIFICATION_FIELDS)]
    for row in gold_difference_classification_rows(results):
        lines.append(
            "\t".join(str(row.get(field, "")) for field in GOLD_DIFFERENCE_CLASSIFICATION_FIELDS)
        )
    return "\n".join(lines)


def gold_difference_classification_to_json(results: list[GoldEvaluationResult]) -> str:
    return json.dumps(
        list(gold_difference_classification_rows(results)),
        ensure_ascii=False,
        indent=2,
    )


def gold_difference_classification_to_jsonl(results: list[GoldEvaluationResult]) -> str:
    output = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        for row in gold_difference_classification_rows(results)
    )
    if output:
        output += "\n"
    return output


def gold_improvement_backlog_rows(
    results: list[GoldEvaluationResult],
) -> tuple[dict[str, Any], ...]:
    groups: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in gold_difference_classification_rows(results):
        if row["classification"] == "match":
            continue
        key = (
            str(row["priority"]),
            str(row["feedback_target"]),
            str(row["classification"]),
            str(row["recommended_action"]),
        )
        group = groups.setdefault(
            key,
            {
                "priority": row["priority"],
                "feedback_target": row["feedback_target"],
                "classification": row["classification"],
                "recommended_action": row["recommended_action"],
                "count": 0,
                "sample_records": [],
                "missing_expected_codes": Counter(),
                "extra_actual_codes": Counter(),
                "message_sources": Counter(),
                "reasons": Counter(),
            },
        )
        group["count"] += 1
        _append_limited(group["sample_records"], str(row["record_id"]), limit=5)
        group["missing_expected_codes"].update(_split_comma_cell(row["missing_expected_codes"]))
        group["extra_actual_codes"].update(_split_comma_cell(row["extra_actual_codes"]))
        group["message_sources"].update(_parse_message_source_counts(row["message_sources"]))
        reason = str(row["reason"] or "")
        if reason:
            group["reasons"].update((reason,))

    rows: list[dict[str, Any]] = []
    for group in groups.values():
        rows.append(
            {
                "priority": group["priority"],
                "feedback_target": group["feedback_target"],
                "classification": group["classification"],
                "recommended_action": group["recommended_action"],
                "count": group["count"],
                "sample_records": ",".join(group["sample_records"]),
                "sample_missing_expected_codes": _counter_samples(
                    group["missing_expected_codes"]
                ),
                "sample_extra_actual_codes": _counter_samples(group["extra_actual_codes"]),
                "sample_message_sources": _counter_samples(group["message_sources"]),
                "sample_reasons": " / ".join(
                    reason for reason, _ in group["reasons"].most_common(3)
                ),
            }
        )
    return tuple(
        sorted(
            rows,
            key=lambda row: (
                _priority_rank(str(row["priority"])),
                -int(row["count"]),
                str(row["feedback_target"]),
                str(row["classification"]),
            ),
        )
    )


def gold_improvement_backlog_to_markdown(results: list[GoldEvaluationResult]) -> str:
    rows = gold_improvement_backlog_rows(results)
    lines = [
        "# Gold Improvement Backlog",
        "",
        f"Backlog items: {len(rows)}",
        f"Records needing action: {sum(int(row['count']) for row in rows)}",
    ]
    if not rows:
        lines.extend(("", "No improvement backlog items."))
        return "\n".join(lines)

    target_counts = Counter()
    classification_counts = Counter()
    for row in rows:
        target_counts[str(row["feedback_target"])] += int(row["count"])
        classification_counts[str(row["classification"])] += int(row["count"])
    lines.extend(("", "| Feedback Target | Count |", "| --- | ---: |"))
    for target, count in sorted(target_counts.items()):
        lines.append(f"| {target} | {count} |")

    lines.extend(("", "| Classification | Count |", "| --- | ---: |"))
    for classification, count in sorted(classification_counts.items()):
        lines.append(f"| {classification} | {count} |")

    lines.extend(
        (
            "",
            "| Priority | Target | Classification | Count | Recommended Action | Sample Records | Sample Codes | Message Sources | Reasons |",
            "| --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
        )
    )
    for row in rows:
        sample_codes = ", ".join(
            part
            for part in (
                str(row["sample_missing_expected_codes"]),
                str(row["sample_extra_actual_codes"]),
            )
            if part
        )
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(str(row["priority"])),
                    _escape_markdown_table_cell(str(row["feedback_target"])),
                    _escape_markdown_table_cell(str(row["classification"])),
                    str(row["count"]),
                    _escape_markdown_table_cell(str(row["recommended_action"])),
                    _escape_markdown_table_cell(str(row["sample_records"])),
                    _escape_markdown_table_cell(sample_codes),
                    _escape_markdown_table_cell(str(row["sample_message_sources"])),
                    _escape_markdown_table_cell(str(row["sample_reasons"])),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def gold_improvement_backlog_to_csv(results: list[GoldEvaluationResult]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=GOLD_IMPROVEMENT_BACKLOG_FIELDS,
        lineterminator="\n",
    )
    writer.writeheader()
    for row in gold_improvement_backlog_rows(results):
        writer.writerow(row)
    return output.getvalue()


def gold_improvement_backlog_to_tsv(results: list[GoldEvaluationResult]) -> str:
    lines = ["\t".join(GOLD_IMPROVEMENT_BACKLOG_FIELDS)]
    for row in gold_improvement_backlog_rows(results):
        lines.append("\t".join(str(row.get(field, "")) for field in GOLD_IMPROVEMENT_BACKLOG_FIELDS))
    return "\n".join(lines)


def gold_improvement_backlog_to_json(results: list[GoldEvaluationResult]) -> str:
    return json.dumps(list(gold_improvement_backlog_rows(results)), ensure_ascii=False, indent=2)


def gold_improvement_backlog_to_jsonl(results: list[GoldEvaluationResult]) -> str:
    output = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        for row in gold_improvement_backlog_rows(results)
    )
    if output:
        output += "\n"
    return output


def gold_improvement_action_plan_rows(
    results: list[GoldEvaluationResult],
) -> tuple[dict[str, Any], ...]:
    rows: list[dict[str, Any]] = []
    for index, backlog_row in enumerate(gold_improvement_backlog_rows(results), start=1):
        guidance = _gold_action_guidance(
            feedback_target=str(backlog_row["feedback_target"]),
            classification=str(backlog_row["classification"]),
        )
        rows.append(
            {
                "rank": index,
                "owner": guidance.owner,
                "priority": backlog_row["priority"],
                "feedback_target": backlog_row["feedback_target"],
                "classification": backlog_row["classification"],
                "count": backlog_row["count"],
                "recommended_action": backlog_row["recommended_action"],
                "implementation_step": guidance.implementation_step,
                "acceptance_gate": guidance.acceptance_gate,
                "sample_records": backlog_row["sample_records"],
                "sample_missing_expected_codes": backlog_row["sample_missing_expected_codes"],
                "sample_extra_actual_codes": backlog_row["sample_extra_actual_codes"],
                "sample_message_sources": backlog_row["sample_message_sources"],
                "sample_reasons": backlog_row["sample_reasons"],
            }
        )
    return tuple(rows)


def gold_improvement_action_plan_to_markdown(results: list[GoldEvaluationResult]) -> str:
    rows = gold_improvement_action_plan_rows(results)
    lines = [
        "# Gold Improvement Action Plan",
        "",
        f"Action items: {len(rows)}",
        f"Records needing action: {sum(int(row['count']) for row in rows)}",
    ]
    if not rows:
        lines.extend(("", "No action items."))
        return "\n".join(lines)

    owner_counts = Counter()
    for row in rows:
        owner_counts[str(row["owner"])] += int(row["count"])
    lines.extend(("", "| Owner | Records |", "| --- | ---: |"))
    for owner, count in sorted(owner_counts.items()):
        lines.append(f"| {owner} | {count} |")

    lines.extend(
        (
            "",
            "| Rank | Owner | Priority | Target | Classification | Count | Implementation Step | Acceptance Gate | Sample Records | Sample Codes | Message Sources |",
            "| ---: | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
        )
    )
    for row in rows:
        sample_codes = ", ".join(
            part
            for part in (
                str(row["sample_missing_expected_codes"]),
                str(row["sample_extra_actual_codes"]),
            )
            if part
        )
        lines.append(
            "| "
            + " | ".join(
                (
                    str(row["rank"]),
                    _escape_markdown_table_cell(str(row["owner"])),
                    _escape_markdown_table_cell(str(row["priority"])),
                    _escape_markdown_table_cell(str(row["feedback_target"])),
                    _escape_markdown_table_cell(str(row["classification"])),
                    str(row["count"]),
                    _escape_markdown_table_cell(str(row["implementation_step"])),
                    _escape_markdown_table_cell(str(row["acceptance_gate"])),
                    _escape_markdown_table_cell(str(row["sample_records"])),
                    _escape_markdown_table_cell(sample_codes),
                    _escape_markdown_table_cell(str(row["sample_message_sources"])),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def gold_improvement_action_plan_to_csv(results: list[GoldEvaluationResult]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=GOLD_IMPROVEMENT_ACTION_PLAN_FIELDS,
        lineterminator="\n",
    )
    writer.writeheader()
    for row in gold_improvement_action_plan_rows(results):
        writer.writerow(row)
    return output.getvalue()


def gold_improvement_action_plan_to_tsv(results: list[GoldEvaluationResult]) -> str:
    lines = ["\t".join(GOLD_IMPROVEMENT_ACTION_PLAN_FIELDS)]
    for row in gold_improvement_action_plan_rows(results):
        lines.append(
            "\t".join(str(row.get(field, "")) for field in GOLD_IMPROVEMENT_ACTION_PLAN_FIELDS)
        )
    return "\n".join(lines)


def gold_improvement_action_plan_to_json(results: list[GoldEvaluationResult]) -> str:
    return json.dumps(list(gold_improvement_action_plan_rows(results)), ensure_ascii=False, indent=2)


def gold_improvement_action_plan_to_jsonl(results: list[GoldEvaluationResult]) -> str:
    output = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        for row in gold_improvement_action_plan_rows(results)
    )
    if output:
        output += "\n"
    return output


def _gold_action_guidance(
    *,
    feedback_target: str,
    classification: str,
) -> _GoldActionGuidance:
    if feedback_target == "parser_or_engine":
        return _GoldActionGuidance(
            owner="parser_or_engine",
            implementation_step="fix payload parsing or calculation exception before rule tuning",
            acceptance_gate="gold evaluation has zero error verdicts",
        )
    if feedback_target == "input_contract":
        return _GoldActionGuidance(
            owner="hospital_contract",
            implementation_step="update CSV contract, column map, history, comment, or option inputs and rerun manifest",
            acceptance_gate=f"{classification} count is 0 for the affected hospital contract",
        )
    if feedback_target == "input_contract_or_calculation_logic":
        return _GoldActionGuidance(
            owner="triage_input_vs_logic",
            implementation_step="check converted JSONL first; if input is present, add or tighten the calculation rule",
            acceptance_gate=f"{classification} rows move to match or an expected review class",
        )
    if feedback_target in {
        "calculation_logic",
        "calculation_logic_or_mapping",
        "code_selection_logic",
        "point_or_quantity_logic",
    }:
        return _GoldActionGuidance(
            owner="calculation_logic",
            implementation_step="add deterministic rule, mapping, exclusion, or point/quantity fix with a regression gold case",
            acceptance_gate="missing, extra, or point-delta rows for this classification disappear",
        )
    if feedback_target == "facility_standard_master":
        return _GoldActionGuidance(
            owner="facility_standard_master",
            implementation_step="repair facility standard import, dictionary resolution, or hospital profile mapping",
            acceptance_gate="facility_standard_input count is 0 after re-running the same gold set",
        )
    if feedback_target == "master_data_or_mapping_contract":
        return _GoldActionGuidance(
            owner="master_data_or_mapping",
            implementation_step="import missing master rows or fix hospital-local-to-standard code mapping",
            acceptance_gate="master_mapping_gap count is 0 for the same source version and hospital mapping",
        )
    if feedback_target == "gold_label":
        return _GoldActionGuidance(
            owner="gold_label_review",
            implementation_step="confirm the finalized claim source and relabel expected points or candidate codes",
            acceptance_gate="gold_label_missing count is 0 or intentionally excluded from mismatch gates",
        )
    return _GoldActionGuidance(
        owner="manual_triage",
        implementation_step="inspect gold evaluation, classification, converted JSONL, and claim messages together",
        acceptance_gate="row is reassigned to input, master, logic, or gold-label owner",
    )


def _gold_evaluation_row(result: GoldEvaluationResult) -> dict[str, Any]:
    data = result.to_dict()
    return {
        "record_id": data["record_id"],
        "sequence_number": data["sequence_number"],
        "patient_id": data["patient_id"] or "",
        "service_date": data["service_date"] or "",
        "regional_bureau": data["regional_bureau"] or "",
        "medical_institution_code": data["medical_institution_code"] or "",
        "facility_standard_keys": ",".join(data["facility_standard_keys"]),
        "status": data["status"],
        "expected_status": data["expected_status"] or "",
        "overall_verdict": data["overall_verdict"],
        "point_verdict": data["point_verdict"],
        "code_verdict": data["code_verdict"],
        "expected_total_points": "" if data["expected_total_points"] is None else data["expected_total_points"],
        "actual_total_points": "" if data["actual_total_points"] is None else data["actual_total_points"],
        "point_delta": "" if data["point_delta"] is None else data["point_delta"],
        "expected_candidate_codes": ",".join(data["expected_candidate_codes"]),
        "actual_candidate_codes": ",".join(data["actual_candidate_codes"]),
        "missing_expected_codes": ",".join(data["missing_expected_codes"]),
        "extra_actual_codes": ",".join(data["extra_actual_codes"]),
        "message_count": data["message_count"],
        "message_sources": ",".join(
            f"{source}:{count}" for source, count in sorted(data["message_sources"].items())
        ),
        "error": data["error"] or "",
    }


def _gold_difference_classification_row(result: GoldEvaluationResult) -> dict[str, Any]:
    data = result.to_dict()
    classification = _classify_gold_difference(result)
    return {
        "record_id": data["record_id"],
        "sequence_number": data["sequence_number"],
        "patient_id": data["patient_id"] or "",
        "service_date": data["service_date"] or "",
        "regional_bureau": data["regional_bureau"] or "",
        "medical_institution_code": data["medical_institution_code"] or "",
        "status": data["status"],
        "expected_status": data["expected_status"] or "",
        "overall_verdict": data["overall_verdict"],
        "point_delta": "" if data["point_delta"] is None else data["point_delta"],
        "classification": classification.classification,
        "feedback_target": classification.feedback_target,
        "priority": classification.priority,
        "recommended_action": classification.recommended_action,
        "reason": classification.reason,
        "expected_total_points": "" if data["expected_total_points"] is None else data["expected_total_points"],
        "actual_total_points": "" if data["actual_total_points"] is None else data["actual_total_points"],
        "missing_expected_codes": ",".join(data["missing_expected_codes"]),
        "extra_actual_codes": ",".join(data["extra_actual_codes"]),
        "message_sources": ",".join(
            f"{source}:{count}" for source, count in sorted(data["message_sources"].items())
        ),
        "error": data["error"] or "",
    }


def _classify_gold_difference(result: GoldEvaluationResult) -> _GoldDifferenceClassification:
    verdict = result.overall_verdict
    if verdict == "match":
        return _GoldDifferenceClassification(
            classification="match",
            feedback_target="none",
            priority="none",
            recommended_action="no_action",
            reason="calculated claim matches gold labels",
        )
    if verdict == "unlabeled":
        return _GoldDifferenceClassification(
            classification="gold_label_missing",
            feedback_target="gold_label",
            priority="low",
            recommended_action="add expected_total_points or expected_candidate_codes",
            reason="no comparable gold point or code labels were supplied",
        )
    if verdict == "error":
        return _GoldDifferenceClassification(
            classification="batch_execution_error",
            feedback_target="parser_or_engine",
            priority="high",
            recommended_action="fix payload parsing or calculation exception before rule tuning",
            reason=result.batch_result.error or "calculation failed",
        )

    review_classification = _source_based_gold_review_classification(result)
    if verdict in {"status_mismatch", "needs_review"}:
        if review_classification is not None:
            return _with_status_reason(result, review_classification)
        return _GoldDifferenceClassification(
            classification="manual_review_gate",
            feedback_target="triage",
            priority="high" if verdict == "status_mismatch" else "medium",
            recommended_action="inspect claim messages and decide whether input, master, or logic owns the gap",
            reason=_status_reason(result, "review status could not be classified by message source"),
        )

    if review_classification is not None and verdict in {"over", "under", "code_mismatch"}:
        return _with_status_reason(result, review_classification)

    if verdict == "under":
        if result.missing_expected_codes:
            return _GoldDifferenceClassification(
                classification="under_claim_missing_code",
                feedback_target="calculation_logic_or_mapping",
                priority="high",
                recommended_action="add or map the missing expected fee code candidates",
                reason="actual points are below gold and expected codes are missing",
            )
        return _GoldDifferenceClassification(
            classification="under_claim_point_gap",
            feedback_target="point_or_quantity_logic",
            priority="high",
            recommended_action="fix point, quantity, or aggregation rule for existing candidates",
            reason="actual points are below gold without a candidate code gap",
        )
    if verdict == "over":
        if result.extra_actual_codes:
            return _GoldDifferenceClassification(
                classification="over_claim_extra_code",
                feedback_target="calculation_logic",
                priority="high",
                recommended_action="add exclusion, suppression, or stricter eligibility logic for extra codes",
                reason="actual points are above gold and extra codes are present",
            )
        return _GoldDifferenceClassification(
            classification="over_claim_point_gap",
            feedback_target="point_or_quantity_logic",
            priority="high",
            recommended_action="fix point, quantity, or aggregation rule for existing candidates",
            reason="actual points are above gold without an extra code gap",
        )
    if verdict == "code_mismatch":
        if result.missing_expected_codes and result.extra_actual_codes:
            classification = "code_substitution_gap"
            action = "adjust code selection logic so expected and actual candidates converge"
        elif result.missing_expected_codes:
            classification = "missing_expected_code"
            action = "add missing candidate rule or mapping"
        else:
            classification = "extra_actual_code"
            action = "suppress extra candidate or add eligibility guard"
        return _GoldDifferenceClassification(
            classification=classification,
            feedback_target="code_selection_logic",
            priority="medium",
            recommended_action=action,
            reason="point total matches but candidate code set differs from gold",
        )

    return _GoldDifferenceClassification(
        classification="manual_review_gate",
        feedback_target="triage",
        priority="medium",
        recommended_action="inspect gold evaluation row",
        reason=f"unhandled verdict: {verdict}",
    )


def _source_based_gold_review_classification(
    result: GoldEvaluationResult,
) -> _GoldDifferenceClassification | None:
    if result.batch_result.result is None:
        return None
    sources = {message.source for message in result.batch_result.result.messages}
    message_text = " ".join(message.message for message in result.batch_result.result.messages)
    if "comment" in sources:
        return _GoldDifferenceClassification(
            classification="required_comment_input",
            feedback_target="input_contract",
            priority="medium",
            recommended_action="map confirmed comment codes or texts into comment_inputs",
            reason="required comment message is still unresolved",
        )
    if sources & {"electronic_bundle", "electronic_exclusion"}:
        return _GoldDifferenceClassification(
            classification="electronic_rule_review",
            feedback_target="calculation_logic",
            priority="medium",
            recommended_action="turn electronic table bundle or exclusion candidate into deterministic rule handling",
            reason="electronic table candidate message remains in review",
        )
    if sources & {"medical_procedure_master", "drug_master", "specific_material_master"}:
        return _GoldDifferenceClassification(
            classification="master_mapping_gap",
            feedback_target="master_data_or_mapping_contract",
            priority="high",
            recommended_action="import missing master rows or adjust hospital order code mapping",
            reason="master lookup message remains in review",
        )
    if sources & {
        "outpatient_basic_fee",
        "outpatient_price_support_add_on",
        "outpatient_pediatric_add_on",
        "outpatient_management_add_on",
    }:
        return _GoldDifferenceClassification(
            classification="outpatient_basic_input",
            feedback_target="input_contract",
            priority="medium",
            recommended_action=(
                "map fee_kind, information_communication_equipment, same-day, "
                "and large-hospital referral fields into outpatient_basic"
            ),
            reason="outpatient basic fee message remains in review",
        )
    if sources & {"medication_fee", "medication_order"}:
        return _GoldDifferenceClassification(
            classification="medication_input",
            feedback_target="input_contract_or_calculation_logic",
            priority="medium",
            recommended_action=(
                "map delivery_kind, dispensing_kind, dose/quantity/days, "
                "and medication add-on fields"
            ),
            reason="medication fee or medication order message remains in review",
        )
    if sources & {"injection_fee", "injection_order"}:
        return _GoldDifferenceClassification(
            classification="injection_input",
            feedback_target="input_contract_or_calculation_logic",
            priority="medium",
            recommended_action=(
                "map injection route, dose/administrations, and injection add-on fields"
            ),
            reason="injection fee or injection order message remains in review",
        )
    if "treatment_fee" in sources:
        return _GoldDifferenceClassification(
            classification="treatment_input",
            feedback_target="input_contract_or_calculation_logic",
            priority="medium",
            recommended_action="map treatment kind and area_size fields",
            reason="treatment fee message remains in review",
        )
    if "imaging_fee" in sources:
        return _GoldDifferenceClassification(
            classification="imaging_input",
            feedback_target="input_contract_or_calculation_logic",
            priority="medium",
            recommended_action=(
                "map imaging kind, acquisition, diagnostic, equipment, contrast, "
                "and electronic image management fields"
            ),
            reason="imaging fee message remains in review",
        )
    if "inpatient_basic_fee" in sources:
        return _GoldDifferenceClassification(
            classification="inpatient_input",
            feedback_target="input_contract_or_calculation_logic",
            priority="medium",
            recommended_action=(
                "map inpatient basic fee code, days, ward/facility standard, "
                "admission/discharge dates, and ward transfer fields"
            ),
            reason="inpatient basic fee message remains in review",
        )
    if "dpc_claim" in sources:
        return _GoldDifferenceClassification(
            classification="dpc_input",
            feedback_target="input_contract_or_calculation_logic",
            priority="medium",
            recommended_action=(
                "map DPC code, resource diagnosis, surgery/procedure flags, "
                "comorbidity, admission period, and hospital coefficient"
            ),
            reason="DPC claim message remains in review",
        )
    if "lab_warning" in sources:
        if _has_any(message_text, ("hospital_profile", "施設基準", "facility_standard")):
            return _GoldDifferenceClassification(
                classification="facility_standard_input",
                feedback_target="facility_standard_master",
                priority="high",
                recommended_action="repair hospital profile or facility standard import/mapping",
                reason="facility standard or hospital profile warning remains in review",
            )
        if _has_any(message_text, ("履歴", "同一患者", "same-month", "same_month", "月1回")):
            return _GoldDifferenceClassification(
                classification="history_input",
                feedback_target="input_contract",
                priority="medium",
                recommended_action="add same-patient same-month claim history to payload history",
                reason="history completeness warning remains in review",
            )
        if "frequency_limit" in message_text:
            return _GoldDifferenceClassification(
                classification="frequency_limit_review",
                feedback_target="input_contract_or_calculation_logic",
                priority="medium",
                recommended_action="confirm history input and decide frequency-limit suppression rule",
                reason="frequency limit warning remains in review",
            )
        return _GoldDifferenceClassification(
            classification="data_completeness_review",
            feedback_target="input_contract",
            priority="medium",
            recommended_action="add missing clinical or administrative input fields required by the warning",
            reason="lab warning remains in review",
        )
    return None


def _with_status_reason(
    result: GoldEvaluationResult,
    classification: _GoldDifferenceClassification,
) -> _GoldDifferenceClassification:
    priority = "high" if result.overall_verdict == "status_mismatch" else classification.priority
    return _GoldDifferenceClassification(
        classification=classification.classification,
        feedback_target=classification.feedback_target,
        priority=priority,
        recommended_action=classification.recommended_action,
        reason=_status_reason(result, classification.reason),
    )


def _status_reason(result: GoldEvaluationResult, reason: str) -> str:
    if result.expected_status is None:
        return reason
    return (
        f"expected_status={result.expected_status}, "
        f"actual_status={result.batch_result.status}; {reason}"
    )


def _has_any(value: str, needles: tuple[str, ...]) -> bool:
    return any(needle in value for needle in needles)


def _split_comma_cell(value: object) -> tuple[str, ...]:
    return tuple(part.strip() for part in str(value or "").split(",") if part.strip())


def _parse_message_source_counts(value: object) -> Counter[str]:
    counter: Counter[str] = Counter()
    for part in _split_comma_cell(value):
        source, separator, count_text = part.partition(":")
        if not source:
            continue
        if separator:
            try:
                count = int(count_text)
            except ValueError:
                count = 1
        else:
            count = 1
        counter[source] += count
    return counter


def _append_limited(items: list[str], value: str, *, limit: int) -> None:
    if value and value not in items and len(items) < limit:
        items.append(value)


def _counter_samples(counter: Counter[str], *, limit: int = 5) -> str:
    return ",".join(f"{key}:{count}" for key, count in counter.most_common(limit))


def _priority_rank(priority: str) -> int:
    return {"high": 0, "medium": 1, "low": 2, "none": 3}.get(priority, 4)


def _classification_number_cell(value: object) -> str:
    if value is None or value == "":
        return ""
    return _number_cell(float(value))


def _update_audit_message_counters(
    *,
    bureau: str,
    hospital_code: str,
    facility_standard_keys: tuple[str, ...],
    message_source: str,
    message_status: str,
    message_source_status_counts: Counter[tuple[str, str]],
    bureau_message_source_status_counts: Counter[tuple[str, str, str]],
    hospital_message_source_status_counts: Counter[tuple[str, str, str, str]],
    facility_standard_message_source_status_counts: Counter[tuple[str, str, str]],
) -> None:
    message_source_status_counts.update(((message_source, message_status),))
    bureau_message_source_status_counts.update(((bureau, message_source, message_status),))
    hospital_message_source_status_counts.update(
        ((bureau, hospital_code, message_source, message_status),)
    )
    facility_standard_message_source_status_counts.update(
        (facility_standard_key, message_source, message_status)
        for facility_standard_key in facility_standard_keys
    )


def _audit_summary_row(
    *,
    scope: str,
    count: int,
    regional_bureau: str = "",
    medical_institution_code: str = "",
    facility_standard_key: str = "",
    status: str = "",
    message_source: str = "",
    message_status: str = "",
) -> dict[str, Any]:
    return {
        "scope": scope,
        "regional_bureau": regional_bureau,
        "medical_institution_code": medical_institution_code,
        "facility_standard_key": facility_standard_key,
        "status": status,
        "message_source": message_source,
        "message_status": message_status,
        "count": count,
    }


def _gold_expected_payload(payload: dict[str, Any]) -> dict[str, Any]:
    expected = payload.get("expected") or payload.get("gold")
    return expected if isinstance(expected, dict) else {}


def _gold_expected_total_points(payload: dict[str, Any]) -> float | None:
    expected = _gold_expected_payload(payload)
    return _optional_float(
        _first_gold_value(
            (
                expected.get("total_points"),
                expected.get("expected_total_points"),
                payload.get("expected_total_points"),
                payload.get("gold_total_points"),
            )
        )
    )


def _gold_expected_candidate_codes(payload: dict[str, Any]) -> tuple[str, ...]:
    expected = _gold_expected_payload(payload)
    return _string_tuple(
        _first_gold_value(
            (
                expected.get("candidate_codes"),
                expected.get("codes"),
                expected.get("billed_codes"),
                payload.get("expected_candidate_codes"),
                payload.get("gold_candidate_codes"),
            )
        )
    )


def _gold_expected_status(payload: dict[str, Any]) -> str | None:
    expected = _gold_expected_payload(payload)
    return _optional_str(
        _first_gold_value((expected.get("status"), payload.get("expected_status")))
    )


def _first_gold_value(values: tuple[Any, ...]) -> Any:
    for value in values:
        if value is None or value == "":
            continue
        return value
    return None


def _number_cell(value: float | None) -> str:
    if value is None:
        return ""
    return f"{value:g}"


def default_master_sources_from_db(
    conn: sqlite3.Connection,
    *,
    service_date: date,
    regional_bureau: str | None,
    overrides: MasterSourceContext | None = None,
) -> MasterSourceContext:
    overrides = overrides or MasterSourceContext()
    return MasterSourceContext(
        medical_procedure_source_id=(
            overrides.medical_procedure_source_id
            if overrides.medical_procedure_source_id is not None
            else _latest_source_id(conn, "medical_procedure_master", service_date)
        ),
        drug_source_id=(
            overrides.drug_source_id
            if overrides.drug_source_id is not None
            else _latest_source_id(conn, "drug_master", service_date)
        ),
        material_source_id=(
            overrides.material_source_id
            if overrides.material_source_id is not None
            else _latest_source_id(conn, "specific_material_master", service_date)
        ),
        electronic_fee_source_id=(
            overrides.electronic_fee_source_id
            if overrides.electronic_fee_source_id is not None
            else _latest_source_id(conn, "medical_electronic_fee_table", service_date)
        ),
        dpc_electronic_table_source_id=(
            overrides.dpc_electronic_table_source_id
            if overrides.dpc_electronic_table_source_id is not None
            else _latest_source_id(conn, "dpc_electronic_table", service_date)
        ),
        dpc_hospital_coefficient_source_id=(
            overrides.dpc_hospital_coefficient_source_id
            if overrides.dpc_hospital_coefficient_source_id is not None
            else _latest_source_id(conn, "dpc_hospital_coefficient", service_date)
        ),
        comment_source_id=(
            overrides.comment_source_id
            if overrides.comment_source_id is not None
            else _latest_source_id(conn, "comment_related_table", service_date)
        ),
        registry_source_id=(
            overrides.registry_source_id
            if overrides.registry_source_id is not None
            else _regional_latest_source_id(conn, regional_bureau, "hospital_registry", service_date)
        ),
        facility_source_id=(
            overrides.facility_source_id
            if overrides.facility_source_id is not None
            else _regional_latest_source_id(
                conn,
                regional_bureau,
                "facility_standards_medical",
                service_date,
            )
        ),
    )


def _parse_patient(payload: dict[str, Any]) -> PatientContext:
    return PatientContext(
        patient_id=_optional_str(payload.get("patient_id")),
        birth_date=_optional_date(payload.get("birth_date")),
        sex=_optional_str(payload.get("sex")),
    )


def _parse_encounter(payload: dict[str, Any]) -> EncounterContext:
    service_date = _optional_date(payload.get("service_date"))
    if service_date is None:
        raise ValueError("encounter.service_date is required")
    return EncounterContext(
        service_date=service_date,
        medical_institution_code=_optional_str(payload.get("medical_institution_code")),
        regional_bureau=_optional_str(payload.get("regional_bureau")),
        is_outpatient=_bool_value(payload.get("is_outpatient"), default=True),
        admission_date=_optional_date(payload.get("admission_date")),
        discharge_date=_optional_date(payload.get("discharge_date")),
    )


def _parse_master_sources(
    payload: dict[str, Any],
    *,
    default_master_sources: MasterSourceContext | None,
    conn: sqlite3.Connection | None,
    service_date: date,
    regional_bureau: str | None,
) -> MasterSourceContext:
    resolved_defaults = default_master_sources or MasterSourceContext()
    if conn is not None:
        resolved_defaults = default_master_sources_from_db(
            conn,
            service_date=service_date,
            regional_bureau=regional_bureau,
            overrides=resolved_defaults,
        )

    values: dict[str, int | None] = {}
    for field_name in MASTER_SOURCE_FIELDS:
        if field_name in payload:
            values[field_name] = _optional_int(payload.get(field_name))
        else:
            values[field_name] = getattr(resolved_defaults, field_name)
    return MasterSourceContext(**values)


def _parse_charge_inputs(value: Any) -> tuple[ChargeInput, ...]:
    inputs: list[ChargeInput] = []
    for item in _list_value(value):
        if isinstance(item, str):
            code = item.strip()
            quantity = 1.0
        elif isinstance(item, dict):
            code = _optional_str(item.get("code") or item.get("drug_code") or item.get("material_code"))
            quantity = _float_value(item.get("quantity"), default=1.0)
        else:
            raise ValueError(f"charge input must be a string or object, got {type(item).__name__}")
        if code:
            inputs.append(ChargeInput(code=code, quantity=quantity))
    return tuple(inputs)


def _parse_comment_inputs(value: Any) -> tuple[CommentInput, ...]:
    inputs: list[CommentInput] = []
    for item in _list_value(value):
        if isinstance(item, str):
            text = item.strip()
            if not text:
                continue
            if text.isdecimal():
                inputs.append(CommentInput(code=text))
            else:
                inputs.append(CommentInput(text=text))
        elif isinstance(item, dict):
            code = _optional_str(item.get("code") or item.get("comment_code"))
            text = _optional_str(item.get("text") or item.get("comment_text"))
            if code is not None or text is not None:
                inputs.append(CommentInput(code=code, text=text))
        else:
            raise ValueError(f"comment input must be a string or object, got {type(item).__name__}")
    return tuple(inputs)


def _parse_medication_orders(value: Any) -> tuple[MedicationOrder, ...]:
    orders: list[MedicationOrder] = []
    for item in _dict_list(value, "medication_orders"):
        drug_code = _optional_str(item.get("drug_code") or item.get("code"))
        if drug_code is None:
            raise ValueError("medication_orders[].drug_code is required")
        orders.append(
            MedicationOrder(
                drug_code=drug_code,
                total_quantity=_optional_float(item.get("total_quantity")),
                quantity_per_day=_optional_float(item.get("quantity_per_day")),
                days=_optional_int(item.get("days")),
                dose_quantity=_optional_float(item.get("dose_quantity")),
                doses_per_day=_optional_float(item.get("doses_per_day")),
                dispensing_kind=_enum_value(
                    MedicationDispensingKind,
                    item.get("dispensing_kind"),
                    "medication_orders[].dispensing_kind",
                ),
            )
        )
    return tuple(orders)


def _parse_injection_orders(value: Any) -> tuple[InjectionOrder, ...]:
    orders: list[InjectionOrder] = []
    for item in _dict_list(value, "injection_orders"):
        drug_code = _optional_str(item.get("drug_code") or item.get("code"))
        if drug_code is None:
            raise ValueError("injection_orders[].drug_code is required")
        orders.append(
            InjectionOrder(
                drug_code=drug_code,
                total_quantity=_optional_float(item.get("total_quantity")),
                dose_quantity=_optional_float(item.get("dose_quantity")),
                administrations=_float_value(item.get("administrations"), default=1.0),
            )
        )
    return tuple(orders)


def _parse_treatment_orders(value: Any) -> tuple[TreatmentOrder, ...]:
    orders: list[TreatmentOrder] = []
    for item in _dict_list(value, "treatment_orders"):
        kind = _enum_value(TreatmentKind, item.get("kind"), "treatment_orders[].kind")
        if kind is None:
            raise ValueError("treatment_orders[].kind is required")
        orders.append(
            TreatmentOrder(
                kind=kind,
                area_size=_enum_value(
                    TreatmentAreaSizeKind,
                    item.get("area_size"),
                    "treatment_orders[].area_size",
                ),
            )
        )
    return tuple(orders)


def _parse_imaging_orders(value: Any) -> tuple[ImagingOrder, ...]:
    orders: list[ImagingOrder] = []
    for item in _dict_list(value, "imaging_orders"):
        kind = _enum_value(ImagingKind, item.get("kind"), "imaging_orders[].kind")
        if kind is None:
            raise ValueError("imaging_orders[].kind is required")
        orders.append(
            ImagingOrder(
                kind=kind,
                acquisition_kind=_enum_value(
                    ImagingAcquisitionKind,
                    item.get("acquisition_kind"),
                    "imaging_orders[].acquisition_kind",
                ),
                radiography_diagnostic_kind=_enum_value(
                    RadiographyDiagnosticKind,
                    item.get("radiography_diagnostic_kind"),
                    "imaging_orders[].radiography_diagnostic_kind",
                ),
                projection_count=max(
                    1,
                    _int_value(item.get("projection_count", item.get("view_count")), default=1),
                ),
                ct_equipment_kind=_enum_value(
                    CTEquipmentKind,
                    item.get("ct_equipment_kind"),
                    "imaging_orders[].ct_equipment_kind",
                ),
                mri_equipment_kind=_enum_value(
                    MRIEquipmentKind,
                    item.get("mri_equipment_kind"),
                    "imaging_orders[].mri_equipment_kind",
                ),
                head=_bool_value(item.get("head"), default=False),
                joint_use=_bool_value(item.get("joint_use"), default=False),
                contrast=_bool_value(item.get("contrast"), default=False),
                electronic_image_management=_bool_value(
                    item.get("electronic_image_management"),
                    default=False,
                ),
                diagnostic_management_add_on=_bool_value(
                    item.get("diagnostic_management_add_on"),
                    default=False,
                ),
                remote_diagnostic_management_add_on=_bool_value(
                    item.get("remote_diagnostic_management_add_on"),
                    default=False,
                ),
            )
        )
    return tuple(orders)


def _parse_history(payload: dict[str, Any]) -> ClaimHistoryContext:
    return ClaimHistoryContext(
        same_day_history_codes=frozenset(_string_tuple(payload.get("same_day_history_codes"))),
        same_week_history_codes=frozenset(_string_tuple(payload.get("same_week_history_codes"))),
        same_month_history_codes=frozenset(_string_tuple(payload.get("same_month_history_codes"))),
        procedure_history_events=_parse_procedure_history_events(
            payload.get("procedure_history_events")
        ),
        already_billed_judgement_groups=frozenset(
            _string_tuple(payload.get("already_billed_judgement_groups"))
        ),
        bundled_judgement_groups=frozenset(_string_tuple(payload.get("bundled_judgement_groups"))),
        already_billed_lab_management_same_month=_bool_value(
            payload.get("already_billed_lab_management_same_month"),
            default=False,
        ),
        already_billed_collection_fee_codes_same_day=frozenset(
            _string_tuple(payload.get("already_billed_collection_fee_codes_same_day"))
        ),
        already_billed_outpatient_rapid_lab_items_same_day=_int_value(
            payload.get("already_billed_outpatient_rapid_lab_items_same_day"),
            default=0,
        ),
    )


def _parse_procedure_history_events(value: Any) -> tuple[ProcedureHistoryEvent, ...]:
    events: list[ProcedureHistoryEvent] = []
    for item in _dict_list(value, "procedure_history_events"):
        procedure_code = _optional_str(item.get("procedure_code") or item.get("code"))
        service_date = _optional_date(item.get("service_date"))
        if procedure_code is None or service_date is None:
            raise ValueError(
                "procedure_history_events[].procedure_code and service_date are required"
            )
        events.append(ProcedureHistoryEvent(procedure_code=procedure_code, service_date=service_date))
    return tuple(events)


def _parse_lab_options(payload: dict[str, Any]) -> LabOptionContext:
    return LabOptionContext(
        collection_fee_inputs=_string_tuple(payload.get("collection_fee_inputs")),
        outpatient_rapid_lab_eligible_test_item_count=_int_value(
            payload.get("outpatient_rapid_lab_eligible_test_item_count"),
            default=0,
        ),
        outpatient_rapid_lab_same_day_result_explained=_bool_value(
            payload.get("outpatient_rapid_lab_same_day_result_explained"),
            default=False,
        ),
        outpatient_rapid_lab_written_information_provided=_bool_value(
            payload.get("outpatient_rapid_lab_written_information_provided"),
            default=False,
        ),
        outpatient_rapid_lab_result_based_care_provided=_bool_value(
            payload.get("outpatient_rapid_lab_result_based_care_provided"),
            default=False,
        ),
        suppress_all_judgement_fees=_bool_value(
            payload.get("suppress_all_judgement_fees"),
            default=False,
        ),
        lab_management_facility_missing_policy=_lab_management_facility_missing_policy(
            payload.get("lab_management_facility_missing_policy")
        ),
    )


def _lab_management_facility_missing_policy(value: Any) -> str:
    if value is None or str(value).strip() == "":
        return "review"
    policy = str(value).strip().lower()
    if policy not in {"review", "ignore"}:
        raise ValueError(
            "lab_options.lab_management_facility_missing_policy must be review or ignore"
        )
    return policy


def _parse_outpatient_basic(payload: dict[str, Any]) -> OutpatientBasicFeeOptionContext:
    return OutpatientBasicFeeOptionContext(
        fee_kind=_enum_value(OutpatientBasicFeeKind, payload.get("fee_kind"), "outpatient_basic.fee_kind"),
        information_communication_equipment=_bool_value(
            payload.get("information_communication_equipment"),
            default=False,
        ),
        same_day_second_department=_bool_value(payload.get("same_day_second_department"), default=False),
        same_day_revisit=_bool_value(payload.get("same_day_revisit"), default=False),
        large_hospital_no_referral=_bool_value(payload.get("large_hospital_no_referral"), default=False),
        management_explanation_performed=_bool_value(
            payload.get("management_explanation_performed"),
            default=False,
        ),
    )


def _parse_medication_options(payload: dict[str, Any]) -> MedicationOptionContext:
    return MedicationOptionContext(
        delivery_kind=_enum_value(
            MedicationDeliveryKind,
            payload.get("delivery_kind"),
            "medication.delivery_kind",
        ),
        prescription_category=(
            _enum_value(
                MedicationPrescriptionCategory,
                payload.get("prescription_category"),
                "medication.prescription_category",
            )
            or MedicationPrescriptionCategory.OTHER
        ),
        dispensing_kinds=tuple(
            kind
            for kind in (
                _enum_value(
                    MedicationDispensingKind,
                    value,
                    "medication.dispensing_kinds[]",
                )
                for value in _list_value(payload.get("dispensing_kinds"))
            )
            if kind is not None
        ),
        infant=_bool_value(payload.get("infant"), default=False),
        refill_prescription=_bool_value(payload.get("refill_prescription"), default=False),
        special_pharmacy_relationship=_bool_value(
            payload.get("special_pharmacy_relationship"),
            default=False,
        ),
        gargle_only=_bool_value(payload.get("gargle_only"), default=False),
        specific_disease_prescription_management=_bool_value(
            payload.get("specific_disease_prescription_management"),
            default=False,
        ),
        specific_disease_prescription_management_already_billed_same_month=_bool_value(
            payload.get("specific_disease_prescription_management_already_billed_same_month"),
            default=False,
        ),
        anti_malignant_tumor_prescription_management=_bool_value(
            payload.get("anti_malignant_tumor_prescription_management"),
            default=False,
        ),
        anti_malignant_tumor_prescription_management_already_billed_same_month=_bool_value(
            payload.get("anti_malignant_tumor_prescription_management_already_billed_same_month"),
            default=False,
        ),
        generic_name_prescription_add_on=_enum_value(
            GenericNamePrescriptionAddOnKind,
            payload.get("generic_name_prescription_add_on"),
            "medication.generic_name_prescription_add_on",
        ),
    )


def _parse_injection_options(payload: dict[str, Any]) -> InjectionOptionContext:
    return InjectionOptionContext(
        route_kind=_enum_value(InjectionRouteKind, payload.get("route_kind"), "injection.route_kind"),
        infant=_bool_value(payload.get("infant"), default=False),
        drip_infusion_outpatient_other=_bool_value(
            payload.get("drip_infusion_outpatient_other"),
            default=False,
        ),
        biologic_add_on=_bool_value(payload.get("biologic_add_on"), default=False),
        narcotic_add_on=_bool_value(payload.get("narcotic_add_on"), default=False),
        precision_continuous_infusion_add_on=_bool_value(
            payload.get("precision_continuous_infusion_add_on"),
            default=False,
        ),
    )


def _parse_inpatient_basic(payload: dict[str, Any]) -> InpatientBasicFeeOptionContext:
    return InpatientBasicFeeOptionContext(
        basic_fee_code=_optional_str(payload.get("basic_fee_code")),
        basic_fee_days=_int_value(payload.get("basic_fee_days"), default=1),
        facility_standard_key=_optional_str(payload.get("facility_standard_key")),
        ward_kind=_optional_str(payload.get("ward_kind")),
        inpatient_basic_code=_optional_str(payload.get("inpatient_basic_code")),
    )


def _parse_dpc_options(payload: dict[str, Any]) -> DpcOptionContext:
    return DpcOptionContext(
        dpc_claim=_bool_value(payload.get("dpc_claim"), default=False),
        dpc_code=_optional_str(payload.get("dpc_code")),
        icd_code=_optional_str(payload.get("icd_code")),
        mdc_code=_optional_str(payload.get("mdc_code")),
        classification_code=_optional_str(payload.get("classification_code")),
        main_diagnosis=_optional_str(payload.get("main_diagnosis")),
        resource_diagnosis=_optional_str(payload.get("resource_diagnosis")),
        surgery_code=_optional_str(payload.get("surgery_code")),
        procedure_code=_optional_str(payload.get("procedure_code")),
        comorbidity=_optional_str(payload.get("comorbidity")),
        hospital_coefficient=_optional_float(payload.get("hospital_coefficient")),
        disease_state_classification=_optional_str(payload.get("disease_state_classification")),
        age_condition=_optional_str(payload.get("age_condition")),
        month_age_condition=_optional_str(payload.get("month_age_condition")),
        weight_condition=_optional_str(payload.get("weight_condition")),
        jcs_condition=_optional_str(payload.get("jcs_condition")),
        burn_index_condition=_optional_str(payload.get("burn_index_condition")),
        gaf_condition=_optional_str(payload.get("gaf_condition")),
        pregnancy_weeks_condition=_optional_str(payload.get("pregnancy_weeks_condition")),
        delivery_bleeding_amount_condition=_optional_str(
            payload.get("delivery_bleeding_amount_condition")
        ),
        surgery_flag=_optional_str(payload.get("surgery_flag")),
        surgery_procedure_1_flag=_optional_str(payload.get("surgery_procedure_1_flag")),
        surgery_procedure_2_flag=_optional_str(payload.get("surgery_procedure_2_flag")),
        defined_comorbidity_flag=_optional_str(payload.get("defined_comorbidity_flag")),
        severity_age_condition=_optional_str(payload.get("severity_age_condition")),
        severity_jcs_condition=_optional_str(payload.get("severity_jcs_condition")),
        unilateral_bilateral_condition=_optional_str(payload.get("unilateral_bilateral_condition")),
        first_reoperation_condition=_optional_str(payload.get("first_reoperation_condition")),
        one_eye_both_eyes_condition=_optional_str(payload.get("one_eye_both_eyes_condition")),
        one_side_both_sides_condition=_optional_str(payload.get("one_side_both_sides_condition")),
        rehabilitation_condition=_optional_str(payload.get("rehabilitation_condition")),
        mild_severe_condition=_optional_str(payload.get("mild_severe_condition")),
        pre_onset_rankin_scale_condition=_optional_str(
            payload.get("pre_onset_rankin_scale_condition")
        ),
        a_drop_score_condition=_optional_str(payload.get("a_drop_score_condition")),
        transfer_from_other_hospital_ward_condition=_optional_str(
            payload.get("transfer_from_other_hospital_ward_condition")
        ),
        stroke_onset_timing_condition=_optional_str(payload.get("stroke_onset_timing_condition")),
        child_pugh_classification_condition=_optional_str(
            payload.get("child_pugh_classification_condition")
        ),
    )


def _parse_data_completeness(payload: dict[str, Any]) -> DataCompletenessContext:
    return DataCompletenessContext(
        judgement_history_complete=_bool_value(
            payload.get("judgement_history_complete"),
            default=True,
        ),
        lab_management_history_complete=_bool_value(
            payload.get("lab_management_history_complete"),
            default=True,
        ),
        collection_fee_history_complete=_bool_value(
            payload.get("collection_fee_history_complete"),
            default=True,
        ),
        outpatient_rapid_lab_history_complete=_bool_value(
            payload.get("outpatient_rapid_lab_history_complete"),
            default=True,
        ),
    )


def _merged_claim_context_payload(payload: dict[str, Any]) -> dict[str, Any]:
    raw_base = payload.get("claim_context") or payload.get("claim_context_template")
    if raw_base is None:
        merged = dict(payload)
    elif isinstance(raw_base, dict):
        merged = dict(raw_base)
        for field_name in CLAIM_CONTEXT_FIELDS:
            if field_name in payload:
                merged[field_name] = payload[field_name]
    else:
        raise ValueError("claim_context must be an object")

    encounter = dict(_dict_value(merged, "encounter"))
    for field_name in ENCOUNTER_FIELDS:
        if field_name in payload and field_name not in encounter:
            encounter[field_name] = payload[field_name]
    if encounter:
        merged["encounter"] = encounter

    master_sources = dict(_dict_value(merged, "master_sources"))
    for field_name in MASTER_SOURCE_FIELDS:
        if field_name in payload and field_name not in master_sources:
            master_sources[field_name] = payload[field_name]
    if master_sources:
        merged["master_sources"] = master_sources

    return merged


def _line_to_dict(line: CalculationLine) -> dict[str, Any]:
    return {
        "code": line.code,
        "name": line.name,
        "points": line.points,
        "quantity": line.quantity,
        "status": line.status.value,
        "reason": line.reason,
        "source": line.source,
        "total_points": line.total_points,
        "excluded_from_total": line.excluded_from_total,
        "coverage": _line_coverage_to_dict(line),
    }


def _line_coverage_to_dict(line: CalculationLine) -> dict[str, Any]:
    support_level = line.support_level or _default_line_support_level(line)
    review_required = line.review_required
    if review_required is None:
        review_required = line.status in {
            ClaimItemStatus.CANDIDATE,
            ClaimItemStatus.NEEDS_REVIEW,
            ClaimItemStatus.WARNING,
            ClaimItemStatus.BLOCKED,
        } or line.source == "medical_procedure_master"

    return {
        "scope": line.coverage_scope or _default_line_coverage_scope(line),
        "chapter": line.coverage_chapter or _default_line_coverage_chapter(line),
        "support_level": support_level,
        "review_required": bool(review_required),
    }


def _default_line_support_level(line: CalculationLine) -> str:
    if line.source == "medical_procedure_master":
        return "review_required"
    if line.status == ClaimItemStatus.CONFIRMED:
        return "supported"
    if line.status == ClaimItemStatus.CANDIDATE:
        return "candidate"
    return "review_required"


def _default_line_coverage_scope(line: CalculationLine) -> str:
    if line.source == "medical_procedure_master":
        return "master_lookup_only"
    if line.status == ClaimItemStatus.CONFIRMED:
        return "deterministic_rule"
    if line.status == ClaimItemStatus.CANDIDATE:
        return "candidate_rule"
    return "review_required"


def _default_line_coverage_chapter(line: CalculationLine) -> str:
    return {
        "outpatient_basic_fee": "A_basic_fee",
        "outpatient_price_support_add_on": "A_basic_fee",
        "outpatient_pediatric_add_on": "A_basic_fee",
        "outpatient_management_add_on": "A_basic_fee",
        "inpatient_basic_fee": "A_inpatient_fee",
        "drug_master": "F_drug",
        "medication_fee": "F_drug",
        "injection_fee": "G_injection",
        "treatment_fee": "J_treatment",
        "imaging_fee": "E_imaging",
        "specific_material_master": "specific_material",
        "medical_procedure_master": "procedure_code_master",
    }.get(line.source, "unknown")


def _message_to_dict(message: CalculationMessage) -> dict[str, str | None]:
    return {
        "status": message.status.value,
        "code": message.code,
        "message": message.message,
        "source": message.source,
    }


def _result_status(result: CalculationResult) -> str:
    review_statuses = {
        ClaimItemStatus.WARNING,
        ClaimItemStatus.BLOCKED,
        ClaimItemStatus.NEEDS_REVIEW,
    }
    if any(message.status in review_statuses for message in result.messages):
        return "needs_review"
    return "ok"


def _iter_jsonl(input_path: str | Path) -> tuple[int, dict[str, Any]]:
    path = Path(input_path)
    with path.open("r", encoding="utf-8") as f:
        for sequence_number, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            payload = json.loads(stripped)
            if not isinstance(payload, dict):
                raise ValueError(f"JSONL row {sequence_number} must be an object")
            yield sequence_number, payload


def _record_id(payload: dict[str, Any], sequence_number: int) -> str:
    value = payload.get("record_id") or payload.get("id") or payload.get("claim_id")
    if value is None or str(value).strip() == "":
        return str(sequence_number)
    return str(value)


def _comment_input_to_payload(comment_input: CommentInput) -> dict[str, str]:
    payload: dict[str, str] = {}
    if comment_input.code is not None:
        payload["code"] = comment_input.code
    if comment_input.text is not None:
        payload["text"] = comment_input.text
    return payload


def _latest_source_id(conn: sqlite3.Connection, source_type: str, service_date: date) -> int | None:
    row = conn.execute(
        """
        SELECT id
        FROM master_sources
        WHERE source_type = ?
          AND (published_at IS NULL OR published_at <= ?)
        ORDER BY COALESCE(published_at, '') DESC, id DESC
        LIMIT 1
        """,
        (source_type, service_date.isoformat()),
    ).fetchone()
    if row is not None:
        return int(row["id"])

    row = conn.execute(
        """
        SELECT id
        FROM master_sources
        WHERE source_type = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (source_type,),
    ).fetchone()
    return None if row is None else int(row["id"])


def _regional_latest_source_id(
    conn: sqlite3.Connection,
    regional_bureau: str | None,
    source_suffix: str,
    service_date: date,
) -> int | None:
    if regional_bureau is None:
        return None
    return _latest_source_id(conn, f"{regional_bureau}_{source_suffix}", service_date)


def _dict_value(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return value


def _dict_list(value: Any, field_name: str) -> tuple[dict[str, Any], ...]:
    items = _list_value(value)
    for item in items:
        if not isinstance(item, dict):
            raise ValueError(f"{field_name}[] must be an object")
    return tuple(items)


def _list_value(value: Any) -> tuple[Any, ...]:
    if value is None:
        return ()
    if isinstance(value, list | tuple):
        return tuple(value)
    if isinstance(value, str):
        if "," in value:
            return tuple(item.strip() for item in value.split(",") if item.strip())
        stripped = value.strip()
        return () if not stripped else (stripped,)
    return (value,)


def _string_tuple(value: Any) -> tuple[str, ...]:
    result: list[str] = []
    for item in _list_value(value):
        if item is None:
            continue
        text = str(item).strip()
        if text:
            result.append(text)
    return tuple(result)


def _optional_frozenset(value: Any) -> frozenset[str] | None:
    if value is None:
        return None
    return frozenset(_string_tuple(value))


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_date(value: Any) -> date | None:
    if value is None or isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    return date.fromisoformat(text)


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _int_value(value: Any, *, default: int) -> int:
    parsed = _optional_int(value)
    return default if parsed is None else parsed


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _float_value(value: Any, *, default: float) -> float:
    parsed = _optional_float(value)
    return default if parsed is None else parsed


def _bool_value(value: Any, *, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y"}:
        return True
    if text in {"0", "false", "f", "no", "n"}:
        return False
    raise ValueError(f"invalid boolean value: {value}")


def _enum_value(enum_type: Any, value: Any, field_name: str) -> Any | None:
    if value is None or value == "":
        return None
    if isinstance(value, enum_type):
        return value
    text = str(value).strip()
    for member in enum_type:
        if text == member.value or text == member.name:
            return member
    raise ValueError(f"invalid {field_name}: {value}")


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
