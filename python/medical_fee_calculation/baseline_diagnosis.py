"""導入前 一括レセプト差分診断のコアロジック。

既存レセ(baselineClaim)と当社再算定(engineClaim)を患者×暦月で突合し、
「算定もれ候補 / 要確認 / 検討」の3分類に振り分ける純粋ロジック。

設計方針は docs/fee-baseline-diff-diagnosis-2026-06-29.md を参照。
- over(既存にあり当社で再現せず)は「過剰」と短絡しない。既知の当社未対応コードは「検討」へ。
- コード突合は正規化(code_map)済みのコードで行う。
- 金額は「点数×10円・総医療費ベースの概算」。負担割合・保険者按分は出さない。
- 入院/DPC・外注など対象外行の除外、コード正規化表の構築は adapter 層の責務。
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 3分類(機械キーと表示ラベル)
CATEGORY_MISSING = "missing_candidate"  # 算定もれ候補
CATEGORY_REVIEW = "needs_review"  # 要確認
CATEGORY_CONSIDER = "consider"  # 検討

CATEGORY_LABELS = {
    CATEGORY_MISSING: "算定もれ候補",
    CATEGORY_REVIEW: "要確認",
    CATEGORY_CONSIDER: "検討",
}

YEN_PER_POINT = 10


def estimate_yen(points: float) -> int:
    """点数→概算影響額(総医療費ベース・点数×10円)。負担按分はしない。"""
    return int(round(float(points or 0) * YEN_PER_POINT))


@dataclass(frozen=True)
class ClaimLine:
    code: str
    name: str = ""
    points: float = 0.0  # 1回あたり点数
    count: float = 1.0  # 回数

    @property
    def total_points(self) -> float:
        return float(self.points or 0) * float(self.count or 0)


@dataclass(frozen=True)
class BaselineClaim:
    """既存レセコンの確定済みレセプト(患者×暦月)。gold ではなく baseline。"""

    patient_id: str
    claim_month: str  # YYYY-MM
    lines: tuple[ClaimLine, ...] = ()
    total_points: float | None = None
    actual_days: int | None = None


@dataclass(frozen=True)
class EngineClaim:
    """当社エンジンで再算定したレセプト(患者×暦月)。"""

    patient_id: str
    claim_month: str
    lines: tuple[ClaimLine, ...] = ()
    total_points: float | None = None
    actual_days: int | None = None
    # 自由文SOAP等で確信度が低い当社候補コード。算定もれ断定を避け「検討」へ回す。
    low_confidence_codes: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class DiagnosisFinding:
    category: str  # CATEGORY_*
    code: str
    name: str
    points: float  # この所見に関わる点数(差分の絶対量)
    side: str  # "engine_only" / "baseline_only" / "both"
    reason: str
    detail: str = ""

    @property
    def category_label(self) -> str:
        return CATEGORY_LABELS.get(self.category, self.category)

    @property
    def estimated_yen(self) -> int:
        return estimate_yen(self.points)


@dataclass(frozen=True)
class ClaimDiagnosis:
    patient_id: str
    claim_month: str
    findings: tuple[DiagnosisFinding, ...]
    baseline_total_points: float
    engine_total_points: float

    @property
    def point_delta(self) -> float:
        return self.engine_total_points - self.baseline_total_points

    def findings_in(self, category: str) -> tuple[DiagnosisFinding, ...]:
        return tuple(finding for finding in self.findings if finding.category == category)

    @property
    def missing_points(self) -> float:
        return sum(finding.points for finding in self.findings_in(CATEGORY_MISSING))

    @property
    def missing_estimated_yen(self) -> int:
        return estimate_yen(self.missing_points)

    def summary(self) -> dict:
        return {
            "patient_id": self.patient_id,
            "claim_month": self.claim_month,
            "baseline_total_points": self.baseline_total_points,
            "engine_total_points": self.engine_total_points,
            "point_delta": self.point_delta,
            "missing_candidate_count": len(self.findings_in(CATEGORY_MISSING)),
            "missing_candidate_points": self.missing_points,
            "missing_candidate_estimated_yen": self.missing_estimated_yen,
            "needs_review_count": len(self.findings_in(CATEGORY_REVIEW)),
            "consider_count": len(self.findings_in(CATEGORY_CONSIDER)),
        }


def _normalize(code: str, code_map: dict[str, str] | None) -> str:
    raw = str(code or "").strip()
    if code_map and raw in code_map:
        return str(code_map[raw]).strip()
    return raw


def _aggregate(lines, code_map):
    """正規化コード単位に回数・点数を集約する。"""
    aggregated: dict[str, dict] = {}
    for line in lines or ():
        code = _normalize(getattr(line, "code", ""), code_map)
        if not code:
            continue
        entry = aggregated.setdefault(code, {"code": code, "name": "", "count": 0.0, "total_points": 0.0})
        if not entry["name"] and getattr(line, "name", ""):
            entry["name"] = line.name
        entry["count"] += float(getattr(line, "count", 1) or 0)
        entry["total_points"] += float(getattr(line, "total_points", 0) or 0)
    return aggregated


def _total(claim, aggregated) -> float:
    if getattr(claim, "total_points", None) is not None:
        return float(claim.total_points)
    return float(sum(entry["total_points"] for entry in aggregated.values()))


def diagnose_claim(
    baseline: BaselineClaim,
    engine: EngineClaim,
    *,
    known_unsupported_codes: frozenset[str] | set[str] = frozenset(),
    code_map: dict[str, str] | None = None,
    point_tolerance: float = 0.0,
) -> ClaimDiagnosis:
    """baselineClaim と engineClaim を突合し3分類の所見を返す。

    - engine のみ(under) → 算定もれ候補。ただし low_confidence は「検討」。
    - baseline のみ(over) → 要確認(当社未対応の可能性/既存の過剰)。
      known_unsupported_codes に該当する場合は「検討(当社未対応の可能性)」へ。
    - 両方あり → 回数/点数差を評価。engine>baseline は算定もれ候補、baseline>engine は要確認。
    """
    unsupported = frozenset(known_unsupported_codes or ())
    low_confidence = frozenset(getattr(engine, "low_confidence_codes", ()) or ())
    base = _aggregate(getattr(baseline, "lines", ()), code_map)
    eng = _aggregate(getattr(engine, "lines", ()), code_map)

    findings: list[DiagnosisFinding] = []
    for code in sorted(set(base) | set(eng)):
        b = base.get(code)
        e = eng.get(code)
        if e and not b:
            # under: 当社で候補だが既存に無い
            name = e["name"]
            points = e["total_points"]
            if code in low_confidence:
                findings.append(DiagnosisFinding(
                    category=CATEGORY_CONSIDER, code=code, name=name, points=points, side="engine_only",
                    reason="低確信の当社候補", detail="抽出の確信度が低いため要根拠確認。",
                ))
            else:
                findings.append(DiagnosisFinding(
                    category=CATEGORY_MISSING, code=code, name=name, points=points, side="engine_only",
                    reason="当社再算定では候補だが既存レセに無い",
                    detail="実施事実・算定要件・施設基準・病名の確認のうえ判断。",
                ))
        elif b and not e:
            # over: 既存にあるが当社で再現せず。過剰と短絡しない。
            name = b["name"]
            points = b["total_points"]
            if code in unsupported:
                findings.append(DiagnosisFinding(
                    category=CATEGORY_CONSIDER, code=code, name=name, points=points, side="baseline_only",
                    reason="当社未対応領域の可能性", detail="当社エンジンが未対応のため差分の判定保留。",
                ))
            else:
                findings.append(DiagnosisFinding(
                    category=CATEGORY_REVIEW, code=code, name=name, points=points, side="baseline_only",
                    reason="既存にあり当社で再現せず（当社未対応の可能性／既存の過剰の可能性）",
                    detail="根拠・要件・施設基準・病名を確認。",
                ))
        else:
            # both: 回数/点数の差を評価
            delta = e["total_points"] - b["total_points"]
            name = e["name"] or b["name"]
            if abs(delta) <= point_tolerance:
                continue
            if delta > 0:
                findings.append(DiagnosisFinding(
                    category=CATEGORY_MISSING, code=code, name=name, points=delta, side="both",
                    reason="当社再算定の方が回数/点数が多い",
                    detail=f"差分 +{delta:g}点。回数・要件を確認。",
                ))
            else:
                findings.append(DiagnosisFinding(
                    category=CATEGORY_REVIEW, code=code, name=name, points=abs(delta), side="both",
                    reason="既存の方が回数/点数が多い（当社未対応の可能性／既存の過剰の可能性）",
                    detail=f"差分 {delta:g}点。根拠・回数を確認。",
                ))

    return ClaimDiagnosis(
        patient_id=baseline.patient_id or engine.patient_id,
        claim_month=baseline.claim_month or engine.claim_month,
        findings=tuple(findings),
        baseline_total_points=_total(baseline, base),
        engine_total_points=_total(engine, eng),
    )
