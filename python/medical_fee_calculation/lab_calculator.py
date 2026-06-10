from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field, replace
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    CalculationResult,
    ClaimContext,
    ClaimItemStatus,
    CommentInput,
)
from medical_fee_calculation.electronic_rules import (
    ElectronicRuleContext,
    ElectronicRuleResult,
    ProcedureHistoryEvent,
    check_electronic_rules,
)
from medical_fee_calculation.hospital_profile import HospitalProfile, get_hospital_profile
from medical_fee_calculation.imaging_fees import calculate_imaging_fees
from medical_fee_calculation.injection_fees import calculate_injection_fees
from medical_fee_calculation.injection_orders import resolve_injection_order_inputs
from medical_fee_calculation.inpatient_fees import calculate_inpatient_fees
from medical_fee_calculation.lab_rules import (
    D026Context,
    D026Result,
    LAB_MANAGEMENT_FEE_BY_STANDARD,
    LabManagementContext,
    LabManagementResult,
    CollectionFeeContext,
    CollectionFeeResult,
    OutpatientRapidLabContext,
    OutpatientRapidLabResult,
    ClaimItem,
    ReviewWarning,
    add_d026_judgement_fees,
    add_lab_management_fee,
    add_collection_fees,
    add_outpatient_rapid_lab_fee,
)
from medical_fee_calculation.medication_fees import calculate_medication_fees
from medical_fee_calculation.medication_orders import resolve_medication_order_inputs
from medical_fee_calculation.outpatient_basic import calculate_outpatient_basic_fee
from medical_fee_calculation.procedure_resolver import (
    resolve_drug_lines,
    resolve_medical_procedure_lines,
    resolve_specific_material_lines,
)
from medical_fee_calculation.treatment_fees import calculate_treatment_fees


@dataclass(frozen=True)
class LabCalculationContext:
    service_date: date
    medical_procedure_source_id: int | None = None
    electronic_fee_source_id: int | None = None
    comment_source_id: int | None = None
    hospital_profile: HospitalProfile | None = None
    facility_standard_keys: frozenset[str] | None = None
    already_billed_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    bundled_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    suppress_all_judgement_fees: bool = False
    already_billed_lab_management_same_month: bool = False
    judgement_history_complete: bool = True
    lab_management_history_complete: bool = True
    same_day_history_codes: frozenset[str] = field(default_factory=frozenset)
    same_week_history_codes: frozenset[str] = field(default_factory=frozenset)
    same_month_history_codes: frozenset[str] = field(default_factory=frozenset)
    procedure_history_events: tuple[ProcedureHistoryEvent, ...] = ()
    collection_fee_inputs: tuple[str, ...] = ()
    already_billed_collection_fee_codes_same_day: frozenset[str] = field(default_factory=frozenset)
    collection_fee_history_complete: bool = True
    is_outpatient: bool = False
    outpatient_rapid_lab_eligible_test_item_count: int = 0
    outpatient_rapid_lab_same_day_result_explained: bool = False
    outpatient_rapid_lab_written_information_provided: bool = False
    outpatient_rapid_lab_result_based_care_provided: bool = False
    already_billed_outpatient_rapid_lab_items_same_day: int = 0
    outpatient_rapid_lab_history_complete: bool = True
    lab_management_facility_missing_policy: str = "review"
    comment_inputs: tuple[CommentInput, ...] = ()


@dataclass(frozen=True)
class LabCalculationResult:
    input_codes: tuple[str, ...]
    claim_items: tuple[ClaimItem, ...]
    d026: D026Result
    lab_management: LabManagementResult
    collection_fees: CollectionFeeResult
    outpatient_rapid_lab: OutpatientRapidLabResult
    electronic_rules: ElectronicRuleResult
    warnings: tuple[ReviewWarning, ...]
    lab_management_facility_missing_policy: str = "review"
    comment_inputs: tuple[CommentInput, ...] = ()

    @property
    def candidate_procedure_codes(self) -> tuple[str, ...]:
        return _unique_codes((*self.input_codes, *(item.code for item in self.claim_items)))

    def to_calculation_result(self) -> CalculationResult:
        return lab_calculation_to_result(self)


def calculate_lab_claim_for_context(
    conn: sqlite3.Connection,
    claim_context: ClaimContext,
) -> LabCalculationResult:
    """Calculate lab claim additions from the shared claim context."""

    hospital_profile = _resolve_hospital_profile(conn, claim_context)
    return calculate_lab_claim(
        conn,
        list(claim_context.procedure_codes),
        lab_context_from_claim_context(claim_context, hospital_profile=hospital_profile),
    )


def calculate_lab_claim_standardized(
    conn: sqlite3.Connection,
    claim_context: ClaimContext,
) -> CalculationResult:
    """Return the lab MVP result in the shared calculation result shape."""

    hospital_profile = _resolve_hospital_profile(conn, claim_context)
    detailed_result = calculate_lab_claim(
        conn,
        list(claim_context.procedure_codes),
        lab_context_from_claim_context(claim_context, hospital_profile=hospital_profile),
    )
    lab_result = detailed_result.to_calculation_result()
    facility_standard_keys = _effective_claim_facility_standard_keys(
        claim_context,
        hospital_profile=hospital_profile,
    )
    medication_order_resolution = resolve_medication_order_inputs(claim_context.medication_orders)
    injection_order_resolution = resolve_injection_order_inputs(claim_context.injection_orders)
    resolved_drug_inputs = (
        *claim_context.drug_inputs,
        *medication_order_resolution.charge_inputs,
        *claim_context.injection_drug_inputs,
        *injection_order_resolution.charge_inputs,
    )
    resolved_medication_drug_inputs = (
        *claim_context.drug_inputs,
        *medication_order_resolution.charge_inputs,
    )
    medication_context = claim_context.medication
    if not medication_context.dispensing_kinds and medication_order_resolution.dispensing_kinds:
        medication_context = replace(
            medication_context,
            dispensing_kinds=medication_order_resolution.dispensing_kinds,
        )

    input_resolution = resolve_medical_procedure_lines(
        conn,
        claim_context.procedure_codes,
        claim_context.encounter.service_date,
        claim_context.master_sources.medical_procedure_source_id,
    )
    drug_resolution = resolve_drug_lines(
        conn,
        resolved_drug_inputs,
        claim_context.encounter.service_date,
        claim_context.master_sources.drug_source_id,
    )
    material_resolution = resolve_specific_material_lines(
        conn,
        claim_context.material_inputs,
        claim_context.encounter.service_date,
        claim_context.master_sources.material_source_id,
    )
    outpatient_basic = calculate_outpatient_basic_fee(
        conn,
        claim_context.procedure_codes,
        claim_context.encounter.service_date,
        claim_context.outpatient_basic,
        is_outpatient=claim_context.encounter.is_outpatient,
        source_id=claim_context.master_sources.medical_procedure_source_id,
    )
    medication_fees = calculate_medication_fees(
        conn,
        claim_context.procedure_codes,
        resolved_medication_drug_inputs,
        claim_context.encounter.service_date,
        medication_context,
        is_outpatient=claim_context.encounter.is_outpatient,
        source_id=claim_context.master_sources.medical_procedure_source_id,
    )
    injection_fees = calculate_injection_fees(
        conn,
        claim_context.procedure_codes,
        claim_context.encounter.service_date,
        claim_context.injection,
        is_outpatient=claim_context.encounter.is_outpatient,
        source_id=claim_context.master_sources.medical_procedure_source_id,
    )
    treatment_fees = calculate_treatment_fees(
        conn,
        claim_context.procedure_codes,
        claim_context.treatment_orders,
        claim_context.encounter.service_date,
        source_id=claim_context.master_sources.medical_procedure_source_id,
    )
    imaging_fees = calculate_imaging_fees(
        conn,
        claim_context.procedure_codes,
        claim_context.imaging_orders,
        claim_context.encounter.service_date,
        source_id=claim_context.master_sources.medical_procedure_source_id,
        facility_standard_keys=facility_standard_keys,
    )
    inpatient_fees = calculate_inpatient_fees(
        conn,
        claim_context.procedure_codes,
        claim_context.encounter.service_date,
        claim_context.inpatient_basic,
        claim_context.dpc,
        is_outpatient=claim_context.encounter.is_outpatient,
        admission_date=claim_context.encounter.admission_date,
        facility_standard_keys=facility_standard_keys,
        source_id=claim_context.master_sources.medical_procedure_source_id,
        electronic_fee_source_id=claim_context.master_sources.electronic_fee_source_id,
        dpc_electronic_table_source_id=claim_context.master_sources.dpc_electronic_table_source_id,
        hospital_profile=hospital_profile,
    )

    return CalculationResult(
        input_codes=_unique_codes(
            (
                *lab_result.input_codes,
                *(charge_input.code for charge_input in resolved_drug_inputs),
                *(charge_input.code for charge_input in claim_context.material_inputs),
            )
        ),
        lines=(
            *input_resolution.lines,
            *drug_resolution.lines,
            *material_resolution.lines,
            *outpatient_basic.lines,
            *medication_fees.lines,
            *injection_fees.lines,
            *treatment_fees.lines,
            *imaging_fees.lines,
            *inpatient_fees.lines,
            *lab_result.lines,
        ),
        messages=(
            *input_resolution.messages,
            *medication_order_resolution.messages,
            *injection_order_resolution.messages,
            *drug_resolution.messages,
            *material_resolution.messages,
            *outpatient_basic.messages,
            *medication_fees.messages,
            *injection_fees.messages,
            *treatment_fees.messages,
            *imaging_fees.messages,
            *inpatient_fees.messages,
            *lab_result.messages,
        ),
    )


def lab_context_from_claim_context(
    claim_context: ClaimContext,
    *,
    hospital_profile: HospitalProfile | None = None,
) -> LabCalculationContext:
    history = claim_context.history
    lab_options = claim_context.lab_options
    master_sources = claim_context.master_sources
    completeness = claim_context.data_completeness
    resolved_profile = hospital_profile if hospital_profile is not None else claim_context.hospital_profile

    return LabCalculationContext(
        service_date=claim_context.encounter.service_date,
        medical_procedure_source_id=master_sources.medical_procedure_source_id,
        electronic_fee_source_id=master_sources.electronic_fee_source_id,
        comment_source_id=master_sources.comment_source_id,
        hospital_profile=resolved_profile,
        facility_standard_keys=claim_context.facility_standard_keys,
        already_billed_judgement_groups=history.already_billed_judgement_groups,
        bundled_judgement_groups=history.bundled_judgement_groups,
        suppress_all_judgement_fees=lab_options.suppress_all_judgement_fees,
        already_billed_lab_management_same_month=history.already_billed_lab_management_same_month,
        judgement_history_complete=completeness.judgement_history_complete,
        lab_management_history_complete=completeness.lab_management_history_complete,
        same_day_history_codes=history.same_day_history_codes,
        same_week_history_codes=history.same_week_history_codes,
        same_month_history_codes=history.same_month_history_codes,
        procedure_history_events=history.procedure_history_events,
        collection_fee_inputs=lab_options.collection_fee_inputs,
        already_billed_collection_fee_codes_same_day=history.already_billed_collection_fee_codes_same_day,
        collection_fee_history_complete=completeness.collection_fee_history_complete,
        is_outpatient=claim_context.encounter.is_outpatient,
        outpatient_rapid_lab_eligible_test_item_count=lab_options.outpatient_rapid_lab_eligible_test_item_count,
        outpatient_rapid_lab_same_day_result_explained=lab_options.outpatient_rapid_lab_same_day_result_explained,
        outpatient_rapid_lab_written_information_provided=lab_options.outpatient_rapid_lab_written_information_provided,
        outpatient_rapid_lab_result_based_care_provided=lab_options.outpatient_rapid_lab_result_based_care_provided,
        already_billed_outpatient_rapid_lab_items_same_day=history.already_billed_outpatient_rapid_lab_items_same_day,
        outpatient_rapid_lab_history_complete=completeness.outpatient_rapid_lab_history_complete,
        lab_management_facility_missing_policy=lab_options.lab_management_facility_missing_policy,
        comment_inputs=claim_context.comment_inputs,
    )


def lab_calculation_to_result(result: LabCalculationResult) -> CalculationResult:
    return CalculationResult(
        input_codes=result.input_codes,
        lines=tuple(
            CalculationLine(
                code=item.code,
                name=item.name,
                points=item.points,
                quantity=item.quantity,
                status=ClaimItemStatus.CANDIDATE,
                reason=item.reason,
                source=_claim_item_source(item.reason),
            )
            for item in result.claim_items
        ),
        messages=_calculation_messages(result),
    )


def calculate_lab_claim(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    context: LabCalculationContext,
) -> LabCalculationResult:
    """Calculate lab claim additions and advisory rule hits.

    The function only appends deterministic add-on candidates for the lab MVP.
    Electronic fee table hits are returned as advisory data so the caller can
    review bundles, exclusions, frequency limits, and required comments before
    finalizing a claim.
    """

    input_codes = _unique_codes(procedure_codes)
    present_judgement_groups = _find_present_judgement_groups(
        conn,
        input_codes,
        context.service_date,
        context.medical_procedure_source_id,
    )

    d026 = add_d026_judgement_fees(
        conn,
        list(input_codes),
        D026Context(
            service_date=context.service_date,
            source_id=context.medical_procedure_source_id,
            already_present_judgement_groups=present_judgement_groups,
            already_billed_judgement_groups=context.already_billed_judgement_groups,
            bundled_judgement_groups=context.bundled_judgement_groups,
            suppress_all_judgement_fees=context.suppress_all_judgement_fees,
            history_complete=context.judgement_history_complete,
        ),
    )

    d026_items = _claim_items_not_already_present(d026.claim_items, input_codes)
    after_d026_codes = _unique_codes((*input_codes, *(item.code for item in d026_items)))
    facility_standard_keys, profile_warnings = _facility_standard_keys(context)

    if after_d026_codes:
        lab_management = add_lab_management_fee(
            conn,
            list(after_d026_codes),
            LabManagementContext(
                service_date=context.service_date,
                source_id=context.medical_procedure_source_id,
                facility_standard_keys=facility_standard_keys,
                already_present_in_claim=_has_lab_management_fee(input_codes),
                already_billed_same_month=context.already_billed_lab_management_same_month,
                history_complete=context.lab_management_history_complete,
            ),
        )
    else:
        lab_management = LabManagementResult(
            claim_item=None,
            skipped_reason=None,
            warnings=(),
        )

    claim_items = list(d026_items)
    if lab_management.claim_item is not None and lab_management.claim_item.code not in after_d026_codes:
        claim_items.append(lab_management.claim_item)

    after_lab_management_codes = _unique_codes((*input_codes, *(item.code for item in claim_items)))
    collection_fees = add_collection_fees(
        conn,
        list(after_lab_management_codes),
        CollectionFeeContext(
            service_date=context.service_date,
            source_id=context.medical_procedure_source_id,
            collection_fee_inputs=context.collection_fee_inputs,
            already_billed_same_day_codes=context.already_billed_collection_fee_codes_same_day,
            history_complete=context.collection_fee_history_complete,
        ),
    )
    for item in collection_fees.claim_items:
        if item.code not in after_lab_management_codes:
            claim_items.append(item)

    after_collection_codes = _unique_codes((*input_codes, *(item.code for item in claim_items)))
    outpatient_rapid_lab = add_outpatient_rapid_lab_fee(
        conn,
        list(after_collection_codes),
        OutpatientRapidLabContext(
            service_date=context.service_date,
            source_id=context.medical_procedure_source_id,
            eligible_test_item_count=context.outpatient_rapid_lab_eligible_test_item_count,
            is_outpatient=context.is_outpatient,
            same_day_result_explained=context.outpatient_rapid_lab_same_day_result_explained,
            written_information_provided=context.outpatient_rapid_lab_written_information_provided,
            result_based_care_provided=context.outpatient_rapid_lab_result_based_care_provided,
            already_billed_same_day_count=context.already_billed_outpatient_rapid_lab_items_same_day,
            history_complete=context.outpatient_rapid_lab_history_complete,
        ),
    )
    if outpatient_rapid_lab.claim_item is not None and outpatient_rapid_lab.claim_item.code not in after_collection_codes:
        claim_items.append(outpatient_rapid_lab.claim_item)

    candidate_codes = _unique_codes((*input_codes, *(item.code for item in claim_items)))
    electronic_rules = check_electronic_rules(
        conn,
        list(candidate_codes),
        ElectronicRuleContext(
            service_date=context.service_date,
            source_id=context.electronic_fee_source_id,
            comment_source_id=context.comment_source_id,
            same_day_history_codes=context.same_day_history_codes,
            same_week_history_codes=context.same_week_history_codes,
            same_month_history_codes=context.same_month_history_codes,
            procedure_history_events=context.procedure_history_events,
        ),
    )

    warnings = (
        *profile_warnings,
        *d026.warnings,
        *lab_management.warnings,
        *collection_fees.warnings,
        *outpatient_rapid_lab.warnings,
        *_frequency_limit_breach_warnings(electronic_rules),
    )

    return LabCalculationResult(
        input_codes=input_codes,
        claim_items=tuple(claim_items),
        d026=d026,
        lab_management=lab_management,
        collection_fees=collection_fees,
        outpatient_rapid_lab=outpatient_rapid_lab,
        electronic_rules=electronic_rules,
        warnings=tuple(warnings),
        lab_management_facility_missing_policy=context.lab_management_facility_missing_policy,
        comment_inputs=context.comment_inputs,
    )


def _resolve_hospital_profile(
    conn: sqlite3.Connection,
    claim_context: ClaimContext,
) -> HospitalProfile | None:
    if claim_context.hospital_profile is not None or claim_context.facility_standard_keys is not None:
        return claim_context.hospital_profile

    medical_institution_code = claim_context.encounter.medical_institution_code
    if not medical_institution_code:
        return None

    return get_hospital_profile(
        conn,
        medical_institution_code,
        claim_context.encounter.service_date,
        regional_bureau=claim_context.encounter.regional_bureau,
        registry_source_id=claim_context.master_sources.registry_source_id,
        facility_source_id=claim_context.master_sources.facility_source_id,
        dpc_coefficient_source_id=claim_context.master_sources.dpc_hospital_coefficient_source_id,
    )


def _effective_claim_facility_standard_keys(
    claim_context: ClaimContext,
    *,
    hospital_profile: HospitalProfile | None,
) -> frozenset[str]:
    if claim_context.facility_standard_keys is not None:
        return claim_context.facility_standard_keys
    if hospital_profile is not None:
        return hospital_profile.facility_standard_keys
    return frozenset()


def _claim_item_source(reason: str) -> str:
    if reason.startswith("D026") or reason.startswith("D026検査判断料"):
        return "d026"
    if reason.startswith("Lab management"):
        return "lab_management"
    if reason.startswith("Collection") or reason.startswith("検体採取料"):
        return "collection_fee"
    if reason.startswith("Outpatient rapid"):
        return "outpatient_rapid_lab"
    return "lab"


def _calculation_messages(result: LabCalculationResult) -> tuple[CalculationMessage, ...]:
    messages: list[CalculationMessage] = []

    for group, reason in result.d026.skipped_groups.items():
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.BLOCKED,
                code=None,
                message=f"D026 judgement group {group} skipped: {reason}",
                source="d026",
            )
        )

    if result.lab_management.skipped_reason is not None and not (
        result.lab_management.skipped_reason == "facility_standard_not_found"
        and result.lab_management_facility_missing_policy == "ignore"
    ):
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.BLOCKED,
                code=None,
                message=f"Lab management fee skipped: {result.lab_management.skipped_reason}",
                source="lab_management",
            )
        )

    for input_value, reason in result.collection_fees.skipped_inputs.items():
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.BLOCKED,
                code=None,
                message=f"Collection fee input {input_value} skipped: {reason}",
                source="collection_fee",
            )
        )

    if (
        result.outpatient_rapid_lab.skipped_reason is not None
        and result.outpatient_rapid_lab.eligible_item_count > 0
    ):
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.BLOCKED,
                code=None,
                message=f"Outpatient rapid lab add-on skipped: {result.outpatient_rapid_lab.skipped_reason}",
                source="outpatient_rapid_lab",
            )
        )

    for bundle in result.electronic_rules.bundles:
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=bundle.bundled_code,
                message=(
                    f"Bundled item candidate: {bundle.bundled_code} {bundle.bundled_name} "
                    f"may be included by {bundle.base_code} {bundle.base_name}"
                ),
                source="electronic_bundle",
            )
        )

    for exclusion in result.electronic_rules.exclusions:
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=exclusion.excluded_code,
                message=(
                    f"Exclusion candidate: {exclusion.base_code} {exclusion.base_name} "
                    f"and {exclusion.excluded_code} {exclusion.excluded_name} "
                    f"matched from {exclusion.matched_from}"
                ),
                source="electronic_exclusion",
            )
        )

    for required_comment in result.electronic_rules.required_comments:
        if _required_comment_fulfilled_by_any_alternative(
            required_comment,
            result.electronic_rules.required_comments,
            result.comment_inputs,
        ):
            continue
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=required_comment.procedure_code,
                message=(
                    f"Required comment candidate: {required_comment.procedure_code} "
                    f"{required_comment.procedure_name} needs {required_comment.comment_code} "
                    f"{required_comment.comment_text}"
                ),
                source="comment",
            )
        )

    for warning in result.warnings:
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message=warning.reason,
                source="lab_warning",
            )
        )

    return tuple(messages)


def _required_comment_fulfilled_by_any_alternative(
    required_comment: object,
    required_comments: tuple[object, ...],
    comment_inputs: tuple[CommentInput, ...],
) -> bool:
    if _required_comment_fulfilled(required_comment, comment_inputs):
        return True

    procedure_code = str(getattr(required_comment, "procedure_code", "") or "").strip()
    requirement_kind = str(getattr(required_comment, "requirement_kind", "") or "").strip()
    group_key = _required_comment_alternative_group_key(required_comment)
    if not procedure_code or not group_key:
        return False

    for sibling in required_comments:
        if sibling is required_comment:
            continue
        if str(getattr(sibling, "procedure_code", "") or "").strip() != procedure_code:
            continue
        if str(getattr(sibling, "requirement_kind", "") or "").strip() != requirement_kind:
            continue
        if _required_comment_alternative_group_key(sibling) != group_key:
            continue
        if _required_comment_fulfilled(sibling, comment_inputs):
            return True
    return False


def _required_comment_fulfilled(
    required_comment: object,
    comment_inputs: tuple[CommentInput, ...],
) -> bool:
    provided_codes = {
        comment_input.code.strip()
        for comment_input in comment_inputs
        if comment_input.code is not None and comment_input.code.strip()
    }
    required_code = str(getattr(required_comment, "comment_code", "") or "").strip()
    if required_code in provided_codes:
        return True

    required_text = _normalize_comment_text(getattr(required_comment, "comment_text", ""))
    if not required_text:
        return False
    for comment_input in comment_inputs:
        if comment_input.text is None:
            continue
        provided_text = _normalize_comment_text(comment_input.text)
        if provided_text == required_text or provided_text.startswith(required_text):
            return True
    return False


def _normalize_comment_text(value: str) -> str:
    return "".join(str(value or "").split())


def _required_comment_alternative_group_key(required_comment: object) -> str:
    text = _normalize_comment_text(getattr(required_comment, "comment_text", ""))
    if not text:
        return ""
    for delimiter in ("：", ":", "ア", "イ", "ウ", "エ", "オ"):
        if delimiter in text:
            return text.split(delimiter, 1)[0]
    return text


def _unique_codes(codes: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for code in codes:
        normalized = str(code or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return tuple(result)


def _claim_items_not_already_present(
    claim_items: tuple[ClaimItem, ...],
    existing_codes: tuple[str, ...],
) -> tuple[ClaimItem, ...]:
    existing = set(existing_codes)
    return tuple(item for item in claim_items if item.code not in existing)


def _facility_standard_keys(
    context: LabCalculationContext,
) -> tuple[frozenset[str], tuple[ReviewWarning, ...]]:
    if context.facility_standard_keys is not None:
        return context.facility_standard_keys, ()

    if context.hospital_profile is None:
        return (
            frozenset(),
            (
                ReviewWarning(
                    level="review",
                    reason="hospital_profile_missing: 施設基準がないため検体検査管理加算は自動追加しない",
                ),
            ),
        )

    warnings = tuple(
        ReviewWarning(
            level="review",
            reason=f"hospital_profile_warning: {warning}",
        )
        for warning in context.hospital_profile.warnings
    )
    return context.hospital_profile.facility_standard_keys, warnings


def _find_present_judgement_groups(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...],
    service_date: date,
    source_id: int | None,
) -> frozenset[str]:
    if not procedure_codes:
        return frozenset()

    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)
    placeholders = ",".join("?" for _ in procedure_codes)
    params.extend(procedure_codes)

    rows = conn.execute(
        f"""
        SELECT DISTINCT judgement_group
        FROM lab_procedure_catalog
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          {source_filter}
          AND code IN ({placeholders})
          AND is_judgement_fee = 1
          AND judgement_group IS NOT NULL
          AND judgement_group <> ''
          AND judgement_group <> '0'
        """,
        params,
    ).fetchall()
    return frozenset(str(row["judgement_group"]) for row in rows)


def _has_lab_management_fee(procedure_codes: tuple[str, ...]) -> bool:
    management_codes = frozenset(LAB_MANAGEMENT_FEE_BY_STANDARD.values())
    return any(code in management_codes for code in procedure_codes)


def _frequency_limit_breach_warnings(
    electronic_rules: ElectronicRuleResult,
) -> tuple[ReviewWarning, ...]:
    return tuple(
        ReviewWarning(
            level="review",
            reason=(
                f"frequency_limit_breach: {breach.procedure_code} {breach.procedure_name} "
                f"は{breach.limit_name}単位の算定回数制限があり、"
                f"{_format_frequency_breach_match(breach.matched_from, breach.matched_service_date)}に同一コードがある"
            ),
        )
        for breach in electronic_rules.frequency_limit_breaches
    )


def _format_frequency_breach_match(
    matched_from: str,
    matched_service_date: date | None,
) -> str:
    if matched_service_date is None:
        return matched_from
    return f"{matched_from}({matched_service_date.isoformat()})"
