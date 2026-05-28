from __future__ import annotations

from dataclasses import dataclass

from medical_fee_calculation.claim_models import (
    CalculationMessage,
    ChargeInput,
    ClaimItemStatus,
    MedicationDispensingKind,
    MedicationOrder,
)


@dataclass(frozen=True)
class MedicationOrderResolveResult:
    charge_inputs: tuple[ChargeInput, ...]
    dispensing_kinds: tuple[MedicationDispensingKind, ...]
    messages: tuple[CalculationMessage, ...]


def resolve_medication_order_inputs(
    medication_orders: tuple[MedicationOrder, ...] | list[MedicationOrder],
) -> MedicationOrderResolveResult:
    """Convert structured medication orders into drug quantity inputs."""

    charge_inputs: list[ChargeInput] = []
    dispensing_kinds: list[MedicationDispensingKind] = []
    messages: list[CalculationMessage] = []

    for order in medication_orders:
        drug_code = str(order.drug_code or "").strip()
        if not drug_code:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message="Medication order skipped: drug code is empty",
                    source="medication_order",
                )
            )
            continue

        quantity = _total_quantity(order)
        if quantity is None or quantity <= 0:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=drug_code,
                    message=(
                        "Medication order skipped: total quantity cannot be calculated "
                        "from total_quantity, quantity_per_day x days, or dose_quantity x doses_per_day x days"
                    ),
                    source="medication_order",
                )
            )
            continue

        charge_inputs.append(ChargeInput(code=drug_code, quantity=quantity))
        if order.dispensing_kind is not None:
            dispensing_kinds.append(order.dispensing_kind)

    return MedicationOrderResolveResult(
        charge_inputs=_aggregate_charge_inputs(tuple(charge_inputs)),
        dispensing_kinds=_unique_dispensing_kinds(tuple(dispensing_kinds)),
        messages=tuple(messages),
    )


def _total_quantity(order: MedicationOrder) -> float | None:
    if order.total_quantity is not None:
        return float(order.total_quantity)

    if order.quantity_per_day is not None and order.days is not None:
        return float(order.quantity_per_day) * int(order.days)

    if (
        order.dose_quantity is not None
        and order.doses_per_day is not None
        and order.days is not None
    ):
        return float(order.dose_quantity) * float(order.doses_per_day) * int(order.days)

    return None


def _aggregate_charge_inputs(inputs: tuple[ChargeInput, ...]) -> tuple[ChargeInput, ...]:
    quantities_by_code: dict[str, float] = {}
    order: list[str] = []
    for charge_input in inputs:
        code = str(charge_input.code or "").strip()
        if not code:
            continue
        if code not in quantities_by_code:
            order.append(code)
            quantities_by_code[code] = 0
        quantities_by_code[code] += float(charge_input.quantity)
    return tuple(ChargeInput(code=code, quantity=quantities_by_code[code]) for code in order)


def _unique_dispensing_kinds(
    dispensing_kinds: tuple[MedicationDispensingKind, ...],
) -> tuple[MedicationDispensingKind, ...]:
    seen: set[MedicationDispensingKind] = set()
    result: list[MedicationDispensingKind] = []
    for kind in dispensing_kinds:
        if kind in seen:
            continue
        seen.add(kind)
        result.append(kind)
    return tuple(result)
