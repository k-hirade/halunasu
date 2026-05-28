from __future__ import annotations

from dataclasses import dataclass

from medical_fee_calculation.claim_models import (
    CalculationMessage,
    ChargeInput,
    ClaimItemStatus,
    InjectionOrder,
)


@dataclass(frozen=True)
class InjectionOrderResolveResult:
    charge_inputs: tuple[ChargeInput, ...]
    messages: tuple[CalculationMessage, ...]


def resolve_injection_order_inputs(
    injection_orders: tuple[InjectionOrder, ...] | list[InjectionOrder],
) -> InjectionOrderResolveResult:
    """Convert structured injection orders into drug quantity inputs."""

    charge_inputs: list[ChargeInput] = []
    messages: list[CalculationMessage] = []

    for order in injection_orders:
        drug_code = str(order.drug_code or "").strip()
        if not drug_code:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message="Injection order skipped: drug code is empty",
                    source="injection_order",
                )
            )
            continue

        quantity = _total_quantity(order)
        if quantity is None or quantity <= 0:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=drug_code,
                    message="Injection order skipped: total quantity cannot be calculated",
                    source="injection_order",
                )
            )
            continue

        charge_inputs.append(ChargeInput(code=drug_code, quantity=quantity))

    return InjectionOrderResolveResult(
        charge_inputs=_aggregate_charge_inputs(tuple(charge_inputs)),
        messages=tuple(messages),
    )


def _total_quantity(order: InjectionOrder) -> float | None:
    if order.total_quantity is not None:
        return float(order.total_quantity)
    if order.dose_quantity is not None:
        return float(order.dose_quantity) * float(order.administrations)
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
