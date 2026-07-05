"""R02: 患者属性チェック(年齢・性別)

性別固有の診療行為・医薬品・傷病名、年齢制限のある算定項目を点検する。
制限データは masters/data/age_sex_restrictions.csv と
診療行為マスターの min_age/max_age/sex 列の両方を参照する。
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule


def _exact_age(receipt: Receipt):
    """診療年月初日時点の年齢(歳、小数)"""
    b = receipt.birthdate_as_date()
    s = receipt.shinryo_ym_as_date()
    if not b or not s:
        return None
    return max((s - b).days / 365.25, 0.0)

# 性別固有の傷病名キーワード(病名文字列での簡易判定)
FEMALE_DISEASE_KEYWORDS = [
    "妊娠", "子宮", "卵巣", "月経", "閉経", "乳腺", "膣", "外陰", "帝王切開", "分娩", "流産", "早産",
]
MALE_DISEASE_KEYWORDS = [
    "前立腺", "精巣", "精索", "陰茎", "包茎", "精嚢",
]


class SexRestrictionRule(Rule):
    rule_id = "PAT-001"
    name = "性別と診療内容の不一致"
    category = "患者属性"
    description = "男性に女性固有(妊娠・子宮等)、女性に男性固有(前立腺等)の傷病名・診療行為がないか点検"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        sex = receipt.sex
        if sex not in ("1", "2"):
            return out

        # 傷病名の性別チェック(キーワードベース)
        for d in receipt.diseases:
            name = d.display_name
            if sex == "1":  # 男性
                for kw in FEMALE_DISEASE_KEYWORDS:
                    if kw in name:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"男性の患者に女性固有と思われる傷病名「{name}」が記録されています",
                                target=name,
                                suggestion="患者の性別または傷病名の誤りがないか確認してください。",
                            )
                        )
                        break
            else:  # 女性
                for kw in MALE_DISEASE_KEYWORDS:
                    if kw in name:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"女性の患者に男性固有と思われる傷病名「{name}」が記録されています",
                                target=name,
                                suggestion="患者の性別または傷病名の誤りがないか確認してください。",
                            )
                        )
                        break

        # 診療行為・医薬品の性別制限(制限マスター)
        for it in receipt.items:
            res = ctx.masters.age_sex_restrictions.get(it.code)
            if res and res.sex and res.sex != sex:
                need = "女性" if res.sex == "2" else "男性"
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{it.display_name}」は{need}にのみ算定できますが、患者は{receipt.sex_label}です",
                        target=it.display_name,
                        detail=res.message,
                    )
                )
            m = ctx.masters.shinryo_koi.get(it.code) if it.rec_type == "SI" else None
            if m and m.sex and m.sex != sex:
                need = "女性" if m.sex == "2" else "男性"
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{it.display_name}」は{need}にのみ算定できますが、患者は{receipt.sex_label}です",
                        target=it.display_name,
                    )
                )
        return out


class AgeRestrictionRule(Rule):
    rule_id = "PAT-002"
    name = "年齢と算定項目の不一致"
    category = "患者属性"
    description = "乳幼児加算・小児科関連など年齢制限のある項目と患者年齢の整合を点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        age = receipt.age
        if age is None:
            return out

        def check_range(code, name, min_age, max_age, extra=""):
            if min_age is not None and age < min_age:
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{name}」は{min_age}歳以上が対象ですが、患者は{age}歳です",
                        target=name,
                        detail=extra,
                    )
                )
            if max_age is not None and age > max_age:
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{name}」は{max_age}歳以下(未満系は設定値まで)が対象ですが、患者は{age}歳です",
                        target=name,
                        detail=extra,
                    )
                )

        for it in receipt.items:
            res = ctx.masters.age_sex_restrictions.get(it.code)
            if res and (res.min_age is not None or res.max_age is not None):
                check_range(it.code, it.display_name, res.min_age, res.max_age, res.message)
                continue  # 制限マスター優先
            if it.rec_type == "SI":
                if ctx.masters.official:
                    m = ctx.masters.official.act(it.code)
                    if m:
                        from ..masters.official import decode_age

                        lower = decode_age(m.get("lower_age"))
                        upper = decode_age(m.get("upper_age"))
                        # 上限年齢は「上限値+1」(算定可能な年齢 < 上限年齢)
                        exact_age = _exact_age(receipt)
                        if lower is not None and exact_age is not None and exact_age < lower:
                            out.append(
                                self.make_finding(
                                    receipt,
                                    f"「{it.display_name}」は下限年齢({m.get('lower_age')})未満の患者に算定されています(患者: {age}歳)",
                                    target=it.display_name,
                                    detail="医科診療行為マスターの下限年齢に基づく判定です。",
                                )
                            )
                        if upper is not None and exact_age is not None and exact_age >= upper:
                            out.append(
                                self.make_finding(
                                    receipt,
                                    f"「{it.display_name}」の対象年齢上限を超えています(患者: {age}歳)",
                                    target=it.display_name,
                                    detail=f"医科診療行為マスターの上限年齢(コード: {m.get('upper_age')})に基づく判定です。B3=3歳・B6=6歳・MG=未就学・BF=15歳・BK=20歳(いずれも到達月の翌月等の細部は近似)。",
                                )
                            )
                    continue
                m2 = ctx.masters.shinryo_koi.get(it.code)
                if m2 and (m2.min_age is not None or m2.max_age is not None):
                    check_range(it.code, it.display_name, m2.min_age, m2.max_age)
        return out


RULES = [SexRestrictionRule(), AgeRestrictionRule()]
FILE_RULES = []
