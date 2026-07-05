"""R07: 併用禁忌チェック

同一レセプト内で併用禁忌の組み合わせにあたる医薬品が同時期に
投与されていないかを点検する。

データソース(優先順):
1. 支払基金チェックマスタ「医薬品併用禁忌関連マスタ」(コードレベル・双方向収載)
2. 施設ルール masters/data/contraindications.csv(一般名レベル)
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule


class OfficialContraindicationRule(Rule):
    rule_id = "CI-001"
    name = "併用禁忌の組み合わせ"
    category = "併用禁忌"
    description = "添付文書上の併用禁忌にあたる医薬品の組み合わせを検出(支払基金チェックマスタ)"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        items_by_code: dict = {}
        for it in receipt.drugs:
            if it.code:
                items_by_code.setdefault(it.code, []).append(it)
        if len(items_by_code) < 2:
            return out

        pairs = official.heiyo_kinki_pairs(list(items_by_code.keys()))
        for code_a, code_b in pairs:
            if code_a == code_b:
                continue
            # 投与時期の重なりを確認(算定日情報があれば日単位で近似)
            overlap = False
            for ia in items_by_code[code_a]:
                for ib in items_by_code[code_b]:
                    if _same_period(ia, ib):
                        overlap = True
                        break
                if overlap:
                    break
            if not overlap:
                continue
            name_a = ctx.masters.drug_name(code_a) or code_a
            name_b = ctx.masters.drug_name(code_b) or code_b
            out.append(
                self.make_finding(
                    receipt,
                    f"併用禁忌: 「{name_a}」と「{name_b}」が同時期に投与されています",
                    target=f"{name_a} × {name_b}",
                    detail="支払基金チェックマスタ(添付文書ベース)の併用禁忌に該当します。",
                    suggestion="処方内容を確認してください。医学的必要性がある場合は症状詳記での説明が必要です。",
                )
            )
        return out


class LocalContraindicationRule(Rule):
    rule_id = "CI-002"
    name = "併用禁忌の組み合わせ(施設ルール)"
    category = "併用禁忌"
    description = "施設ルール(一般名レベル)で定義した併用禁忌の組み合わせを検出"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        if not ctx.masters.contraindications:
            return out
        # レセプト内の医薬品を一般名に解決
        drugs = []  # [(generic, 表示名, item)]
        for it in receipt.drugs:
            m = ctx.masters.iyakuhin.get(it.code)
            generic = (m.generic_name if m else "") or ""
            if generic:
                drugs.append((generic, it.display_name, it))
        if len(drugs) < 2:
            return out

        seen_pairs: set = set()
        for ci in ctx.masters.contraindications:
            a_hits = [d for d in drugs if d[0] == ci.generic_a]
            b_hits = [d for d in drugs if d[0] == ci.generic_b]
            if not a_hits or not b_hits:
                continue
            for _ga, na, ia in a_hits:
                for _gb, nb, ib in b_hits:
                    if ia is ib or not _same_period(ia, ib):
                        continue
                    key = tuple(sorted([na, nb]))
                    if key in seen_pairs:
                        continue
                    seen_pairs.add(key)
                    out.append(
                        self.make_finding(
                            receipt,
                            f"併用禁忌: 「{na}」と「{nb}」が同時期に投与されています(施設ルール)",
                            target=f"{na} × {nb}",
                            detail=ci.reason or f"{ci.name_a}と{ci.name_b}は併用禁忌として登録されています。",
                            suggestion="処方内容を確認してください。",
                        )
                    )
        return out


def _dose_ranges(item) -> list:
    """処方(算定日)ごとの服用期間 [(開始日, 終了日)] を作る。

    内服(21)は算定日の値=その処方の投与日数として服用期間を推定する。
    それ以外(注射・屯服等)は当日限りとして扱う。
    """
    if not item.day_counts:
        return []
    out = []
    naifuku = item.shinryo_shikibetsu == "21"
    for d in item.days_used:
        dur = item.day_counts[d - 1] if naifuku else 1
        out.append((d, d + max(dur - 1, 0)))
    return out


def _same_period(a, b) -> bool:
    """2剤の投与時期が重なる可能性があるか(算定日情報があれば日単位で判定)"""
    ra, rb = _dose_ranges(a), _dose_ranges(b)
    if ra and rb:
        for s1, e1 in ra:
            for s2, e2 in rb:
                if s1 <= e2 and s2 <= e1:
                    return True
        return False
    return True  # 日情報がなければ同月内=重なり得るとみなす


RULES = [OfficialContraindicationRule(), LocalContraindicationRule()]
FILE_RULES = []
