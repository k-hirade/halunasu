"""当社算定エンジンの出力(CalculationResult/ClaimBatchResult)を engineClaim へ写像する配線。

- 患者×暦月で受診(payload)を集約し、当社が前に出す行を EngineClaim にする。
- confirmed は算定根拠が固い行、candidate/needs_review は確信度が低い行として
  low_confidence_codes に入れ、比較器側で「算定もれ断定」を避けて「検討」へ回す。
- これにより baseline_diagnosis の over/under 二義性ルールと整合する。

実エンジン実行(run_outpatient_lab_claim_payloads)はマスタDB(conn)が必要。
本モジュールは「結果→EngineClaim」の写像が中心で、合成結果でも単体テスト可能。
"""

from __future__ import annotations

from medical_fee_calculation.baseline_diagnosis import ClaimLine, EngineClaim

# engineClaim に含める(=当社が前に出す)ステータス。
DEFAULT_INCLUDED_STATUSES = frozenset({"confirmed", "candidate", "needs_review"})
# confirmed 以外は確信度が低い扱い(算定もれ断定を避ける)。
DEFAULT_CONFIRMED_STATUSES = frozenset({"confirmed"})


def _status_value(line) -> str:
    status = getattr(line, "status", "")
    return getattr(status, "value", status) or ""


def engine_claim_from_results(
    results,
    *,
    patient_id: str,
    claim_month: str,
    included_statuses=DEFAULT_INCLUDED_STATUSES,
    confirmed_statuses=DEFAULT_CONFIRMED_STATUSES,
) -> EngineClaim:
    """その患者×月の算定結果(CalculationResult)群を1つの EngineClaim に集約する。

    results: CalculationResult 互換(.lines を持つ)の列。各 line は code/name/points/quantity/status。
    """
    aggregated: dict[str, dict] = {}
    order: list[str] = []
    low_confidence: set[str] = set()
    confirmed_codes: set[str] = set()

    for result in results:
        if result is None:
            continue
        for line in getattr(result, "lines", ()) or ():
            status = _status_value(line)
            if status not in included_statuses:
                continue
            code = str(getattr(line, "code", "") or "").strip()
            if not code:
                continue
            if code not in aggregated:
                aggregated[code] = {"name": getattr(line, "name", "") or "", "points": float(getattr(line, "points", 0) or 0), "count": 0.0}
                order.append(code)
            aggregated[code]["count"] += float(getattr(line, "quantity", 1) or 0)
            if status in confirmed_statuses:
                confirmed_codes.add(code)
            else:
                low_confidence.add(code)

    # 同一コードが confirmed と candidate 両方で出たら confirmed を優先(低確信から外す)。
    low_confidence -= confirmed_codes

    lines = tuple(
        ClaimLine(code=code, name=aggregated[code]["name"], points=aggregated[code]["points"], count=aggregated[code]["count"] or 1.0)
        for code in order
    )
    return EngineClaim(
        patient_id=patient_id,
        claim_month=claim_month,
        lines=lines,
        low_confidence_codes=frozenset(low_confidence),
    )


def _month_of(payload: dict) -> str:
    encounter = payload.get("encounter") if isinstance(payload, dict) else None
    service_date = ""
    if isinstance(encounter, dict):
        service_date = str(encounter.get("service_date") or "")
    return service_date[:7]


def _patient_of(payload: dict) -> str:
    patient = payload.get("patient") if isinstance(payload, dict) else None
    if isinstance(patient, dict) and patient.get("patient_id"):
        return str(patient["patient_id"])
    return ""


def run_engine_claims(conn, payloads, *, runner=None, **engine_options) -> list[EngineClaim]:
    """受診payload群を実エンジンで算定し、患者×月の EngineClaim 群に集約する。

    runner(conn, payloads) -> list[ClaimBatchResult] を差し替え可能(テストで注入)。
    既定は run_outpatient_lab_claim_payloads。
    """
    if runner is None:
        from medical_fee_calculation.claim_batch import run_outpatient_lab_claim_payloads as runner  # noqa: PLC0415

    payloads = list(payloads)
    results = runner(conn, payloads)

    # payload と result はインデックス対応(runner は順序を保持)。
    groups: dict[tuple[str, str], dict] = {}
    order: list[tuple[str, str]] = []
    for payload, result in zip(payloads, results):
        patient_id = _patient_of(payload) or getattr(result, "patient_id", "") or ""
        claim_month = _month_of(payload) or str(getattr(result, "service_date", "") or "")[:7]
        key = (patient_id, claim_month)
        if key not in groups:
            groups[key] = {"results": []}
            order.append(key)
        if getattr(result, "result", None) is not None:
            groups[key]["results"].append(result.result)

    return [
        engine_claim_from_results(groups[key]["results"], patient_id=key[0], claim_month=key[1], **engine_options)
        for key in order
    ]
