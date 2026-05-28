from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ChargeInput,
    ClaimItemStatus,
    GenericNamePrescriptionAddOnKind,
    MedicationDeliveryKind,
    MedicationDispensingKind,
    MedicationOptionContext,
    MedicationPrescriptionCategory,
)


@dataclass(frozen=True)
class MedicationFeeResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


DISPENSING_FEE_CODES = {
    MedicationDispensingKind.INTERNAL_OR_PRN: "120000710",
    MedicationDispensingKind.EXTERNAL: "120001010",
}

PRESCRIPTION_FEE_CODES = {
    MedicationPrescriptionCategory.PSYCHOTROPIC_POLYPHARMACY: "120003610",
    MedicationPrescriptionCategory.SEVEN_OR_MORE_INTERNAL_MEDICINES: "120002610",
    MedicationPrescriptionCategory.PSYCHOTROPIC_LONG_TERM: "120004410",
    MedicationPrescriptionCategory.OTHER: "120001210",
}

PRESCRIPTION_SLIP_FEE_CODES = {
    (False, False, MedicationPrescriptionCategory.PSYCHOTROPIC_POLYPHARMACY): "120003710",
    (False, False, MedicationPrescriptionCategory.SEVEN_OR_MORE_INTERNAL_MEDICINES): "120002710",
    (False, False, MedicationPrescriptionCategory.PSYCHOTROPIC_LONG_TERM): "120004610",
    (False, False, MedicationPrescriptionCategory.OTHER): "120002910",
    (True, False, MedicationPrescriptionCategory.PSYCHOTROPIC_POLYPHARMACY): "120004710",
    (True, False, MedicationPrescriptionCategory.SEVEN_OR_MORE_INTERNAL_MEDICINES): "120004810",
    (True, False, MedicationPrescriptionCategory.PSYCHOTROPIC_LONG_TERM): "120004910",
    (True, False, MedicationPrescriptionCategory.OTHER): "120005010",
    (False, True, MedicationPrescriptionCategory.PSYCHOTROPIC_POLYPHARMACY): "120005810",
    (False, True, MedicationPrescriptionCategory.SEVEN_OR_MORE_INTERNAL_MEDICINES): "120005910",
    (False, True, MedicationPrescriptionCategory.PSYCHOTROPIC_LONG_TERM): "120006010",
    (False, True, MedicationPrescriptionCategory.OTHER): "120006110",
    (True, True, MedicationPrescriptionCategory.PSYCHOTROPIC_POLYPHARMACY): "120006210",
    (True, True, MedicationPrescriptionCategory.SEVEN_OR_MORE_INTERNAL_MEDICINES): "120006310",
    (True, True, MedicationPrescriptionCategory.PSYCHOTROPIC_LONG_TERM): "120006410",
    (True, True, MedicationPrescriptionCategory.OTHER): "120006510",
}

SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_CODES = {
    MedicationDeliveryKind.IN_HOUSE: "120005610",
    MedicationDeliveryKind.OUTSIDE_PRESCRIPTION: "120005710",
}

ANTI_MALIGNANT_TUMOR_PRESCRIPTION_MANAGEMENT_CODES = {
    MedicationDeliveryKind.IN_HOUSE: "120003370",
    MedicationDeliveryKind.OUTSIDE_PRESCRIPTION: "120003470",
}

GENERIC_NAME_PRESCRIPTION_ADD_ON_CODES = {
    GenericNamePrescriptionAddOnKind.ADD_ON_1: "120004270",
    GenericNamePrescriptionAddOnKind.ADD_ON_2: "120003570",
}

MEDICATION_FEE_CODE_SET = frozenset(
    (
        *DISPENSING_FEE_CODES.values(),
        *PRESCRIPTION_FEE_CODES.values(),
        *PRESCRIPTION_SLIP_FEE_CODES.values(),
        *SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_CODES.values(),
        *ANTI_MALIGNANT_TUMOR_PRESCRIPTION_MANAGEMENT_CODES.values(),
        *GENERIC_NAME_PRESCRIPTION_ADD_ON_CODES.values(),
    )
)


def calculate_medication_fees(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    drug_inputs: tuple[ChargeInput, ...] | list[ChargeInput],
    service_date: date,
    context: MedicationOptionContext,
    *,
    is_outpatient: bool,
    source_id: int | None = None,
) -> MedicationFeeResult:
    """Return outpatient medication fee candidates for explicit medication context."""

    if context.delivery_kind is None:
        return MedicationFeeResult(lines=(), messages=())

    if not is_outpatient:
        return MedicationFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=None,
                    message="Medication fee skipped: outpatient encounter is required",
                    source="medication_fee",
                ),
            ),
        )

    if context.gargle_only:
        return MedicationFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=None,
                    message="Medication fee skipped: gargle-only medication does not bill F000/F100/F400",
                    source="medication_fee",
                ),
            ),
        )

    if context.delivery_kind == MedicationDeliveryKind.IN_HOUSE and not _has_drug_inputs(drug_inputs):
        return MedicationFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message="In-house medication fee requires drug inputs",
                    source="medication_fee",
                ),
            ),
        )

    candidate_codes, candidate_messages = _candidate_medication_fee_codes(context)
    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = list(candidate_messages)
    current_codes = set(_unique_codes(tuple(procedure_codes)))

    if (
        context.delivery_kind == MedicationDeliveryKind.IN_HOUSE
        and not context.dispensing_kinds
        and _has_drug_inputs(drug_inputs)
    ):
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message="F000 dispensing fee not added: dispensing kind is not provided",
                source="medication_fee",
            )
        )

    for code in candidate_codes:
        if code in current_codes:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=code,
                    message=f"Medication fee skipped: already present in claim {code}",
                    source="medication_fee",
                )
            )
            continue

        row = _find_medical_procedure(conn, code, service_date, source_id)
        if row is None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=f"Medication fee code not found for service date: {code}",
                    source="medication_fee",
                )
            )
            continue

        lines.append(
            CalculationLine(
                code=str(row["code"]),
                name=str(row["short_name"]),
                points=float(row["points"]),
                quantity=1,
                status=ClaimItemStatus.CANDIDATE,
                reason=f"Medication fee candidate for {context.delivery_kind.value}",
                source="medication_fee",
            )
        )

    return MedicationFeeResult(lines=tuple(lines), messages=tuple(messages))


def _candidate_medication_fee_codes(
    context: MedicationOptionContext,
) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    messages: list[CalculationMessage] = []

    if context.delivery_kind == MedicationDeliveryKind.IN_HOUSE:
        codes = [
            *(DISPENSING_FEE_CODES[kind] for kind in context.dispensing_kinds if kind in DISPENSING_FEE_CODES),
            PRESCRIPTION_FEE_CODES[context.prescription_category],
        ]
        _append_management_add_on_codes(codes, messages, context)
        if context.generic_name_prescription_add_on is not None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message="Generic name prescription add-on is only supported for outside prescriptions",
                    source="medication_fee",
                )
            )
        return _unique_codes(tuple(codes)), tuple(messages)

    if context.delivery_kind == MedicationDeliveryKind.OUTSIDE_PRESCRIPTION:
        codes = [
            PRESCRIPTION_SLIP_FEE_CODES[
                (
                    context.refill_prescription,
                    context.special_pharmacy_relationship,
                    context.prescription_category,
                )
            ]
        ]
        _append_management_add_on_codes(codes, messages, context)
        if context.generic_name_prescription_add_on is not None:
            codes.append(
                GENERIC_NAME_PRESCRIPTION_ADD_ON_CODES[context.generic_name_prescription_add_on]
            )
        return _unique_codes(tuple(codes)), tuple(messages)

    return (), tuple(messages)


def _append_management_add_on_codes(
    codes: list[str],
    messages: list[CalculationMessage],
    context: MedicationOptionContext,
) -> None:
    if context.delivery_kind is None:
        return

    if context.specific_disease_prescription_management:
        if context.specific_disease_prescription_management_already_billed_same_month:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_CODES[context.delivery_kind],
                    message="Specific disease prescription management add-on skipped: already billed same month",
                    source="medication_fee",
                )
            )
        else:
            codes.append(SPECIFIC_DISEASE_PRESCRIPTION_MANAGEMENT_CODES[context.delivery_kind])

    if context.anti_malignant_tumor_prescription_management:
        if context.anti_malignant_tumor_prescription_management_already_billed_same_month:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=ANTI_MALIGNANT_TUMOR_PRESCRIPTION_MANAGEMENT_CODES[context.delivery_kind],
                    message="Anti-malignant tumor prescription management add-on skipped: already billed same month",
                    source="medication_fee",
                )
            )
        else:
            codes.append(
                ANTI_MALIGNANT_TUMOR_PRESCRIPTION_MANAGEMENT_CODES[context.delivery_kind]
            )


def _find_medical_procedure(
    conn: sqlite3.Connection,
    procedure_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, procedure_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT code, short_name, points
        FROM medical_procedures
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND code = ?
          {source_filter}
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _has_drug_inputs(drug_inputs: tuple[ChargeInput, ...] | list[ChargeInput]) -> bool:
    return any(str(item.code or "").strip() and float(item.quantity) > 0 for item in drug_inputs)


def _unique_codes(codes: tuple[str, ...]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for code in codes:
        normalized = str(code or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return tuple(result)
