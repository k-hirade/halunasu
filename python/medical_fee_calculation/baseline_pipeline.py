"""導入前 一括レセプト差分診断のオーケストレーション。

既存レセ(baselineClaim) と 当社再算定(engineClaim) を患者×暦月で突合し、
BatchDiagnosis(3分類)を返す。adapter / engine / diagnosis / report を束ねる層。
"""

from __future__ import annotations

from medical_fee_calculation.baseline_diagnosis import BaselineClaim, EngineClaim
from medical_fee_calculation.baseline_report import BatchDiagnosis, diagnose_batch


def _key(claim) -> tuple[str, str]:
    return (str(getattr(claim, "patient_id", "") or ""), str(getattr(claim, "claim_month", "") or ""))


def build_pairs(baselines, engines) -> list[tuple[BaselineClaim, EngineClaim]]:
    """患者×月で baseline と engine を突合。片側のみのレセも空の相手と対にする。"""
    baseline_by_key = {_key(claim): claim for claim in baselines}
    engine_by_key = {_key(claim): claim for claim in engines}
    pairs: list[tuple[BaselineClaim, EngineClaim]] = []
    seen: set[tuple[str, str]] = set()
    # baseline 側の順序を優先、その後 engine のみのキー。
    for key in list(baseline_by_key.keys()) + [k for k in engine_by_key if k not in baseline_by_key]:
        if key in seen:
            continue
        seen.add(key)
        patient_id, claim_month = key
        baseline = baseline_by_key.get(key) or BaselineClaim(patient_id=patient_id, claim_month=claim_month, lines=())
        engine = engine_by_key.get(key) or EngineClaim(patient_id=patient_id, claim_month=claim_month, lines=())
        pairs.append((baseline, engine))
    return pairs


def run_diagnosis(baselines, engines, **options) -> BatchDiagnosis:
    """baseline群とengine群を突合し3分類の BatchDiagnosis を返す。options は diagnose_claim へ委譲。"""
    return diagnose_batch(build_pairs(baselines, engines), **options)
