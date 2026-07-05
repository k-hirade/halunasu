"""R04: 医薬品の適応チェック(薬剤 ⇔ 傷病名)

投薬・注射された医薬品に対応する適応傷病名がレセプトに記録されているかを
点検する。査定事由A(適応外)に直結する、市販チェックソフトでも中核のチェック。

データソース(優先順):
1. 支払基金チェックマスタ「医薬品適応関連マスタ」(添付文書の効能・効果
   ベース、性別・年齢条件付き) — masters.db
2. 施設ルール masters/data/drug_indications.csv(キーワード照合可)

公的データ・施設ルールのいずれにも適応情報がない医薬品は対象外
(過剰検知の防止。支払基金が適応チェック対象としていない薬剤)。
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule
from .helpers import (
    age_matches,
    disease_codes_of,
    patient_age_years,
    sex_matches,
    suspected_only_codes,
)

MAX_CANDIDATES = 5


def _local_match(receipt: Receipt, disease_codes: set, keywords: list) -> bool:
    """施設ルール(コード集合+キーワード)との照合"""
    for d in receipt.diseases:
        if d.code and d.code in disease_codes:
            return True
        name = d.display_name
        for kw in keywords:
            if kw and kw in name:
                return True
    return False


class DrugIndicationRule(Rule):
    rule_id = "IY-001"
    name = "医薬品の適応病名なし"
    category = "医薬品適応"
    description = "投薬・注射された医薬品の適応に対応する傷病名がレセプトにあるか点検(支払基金チェックマスタ+施設ルール)"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        age = patient_age_years(receipt)
        diseases = disease_codes_of(receipt)
        suspected = suspected_only_codes(receipt)
        reported: set = set()

        for it in receipt.drugs:
            if not it.code or it.code in reported:
                continue
            reported.add(it.code)

            rows = official.drug_indications(it.code) if official else ()
            if rows:
                out.extend(
                    self._check_official(receipt, ctx, it, rows, age, diseases, suspected)
                )
                continue

            # 公的データがない薬剤は施設ルールで補完
            ind = ctx.masters.drug_indications.get(it.code)
            if ind is None:
                continue
            if not _local_match(receipt, ind.disease_codes, ind.disease_keywords):
                expected = "、".join(ind.disease_keywords[:MAX_CANDIDATES]) or "適応傷病名"
                out.append(
                    self.make_finding(
                        receipt,
                        f"医薬品「{it.display_name}」に対応する適応病名が見当たりません(施設ルール)",
                        target=it.display_name,
                        detail=f"想定される適応病名の例: {expected}",
                        suggestion="適応に該当する傷病名を記録するか、投与の妥当性を確認してください。適応外投与は査定事由A(適応外)の対象です。",
                    )
                )
        return out

    def _check_official(self, receipt, ctx, it, rows, age, diseases, suspected) -> list:
        """支払基金チェックマスタによる適応判定"""
        applicable = [
            r for r in rows
            if sex_matches(r[1], receipt.sex) and age_matches(r[2], r[3], age)
        ]
        if not applicable:
            # 適応行はあるが、患者の性別・年齢に合う行がひとつもない
            return [
                self.make_finding(
                    receipt,
                    f"医薬品「{it.display_name}」は患者の性別・年齢({receipt.sex_label}・{receipt.age}歳)に該当する適応がありません",
                    target=it.display_name,
                    suggestion="投与対象(性別・年齢)を確認してください。",
                )
            ]
        allowed = {r[0] for r in applicable}
        hit = allowed & diseases
        if hit:
            if hit <= suspected:
                return [
                    self.make_finding(
                        receipt,
                        f"医薬品「{it.display_name}」の適応病名が「疑い」病名しかありません",
                        severity=Severity.INFO,
                        target=it.display_name,
                        suggestion="疑い病名に対する治療薬の投与は査定対象になり得ます。確定病名の記録を検討してください(検査は疑い病名で可、治療は原則確定病名)。",
                    )
                ]
            return []
        candidates = self._candidate_names(ctx, sorted(allowed))
        return [
            self.make_finding(
                receipt,
                f"医薬品「{it.display_name}」に対応する適応傷病名が記録されていません",
                target=it.display_name,
                detail=f"適応病名の候補例: {candidates}" if candidates else "支払基金チェックマスタに適応傷病名の定義があります。",
                suggestion="診療実態に合う適応病名を記録するか、投与理由を摘要欄に記載してください。病名もれはA査定・突合点検の最多要因です。",
            )
        ]

    @staticmethod
    def _candidate_names(ctx: CheckContext, codes: list) -> str:
        names = []
        for c in codes:
            n = ctx.masters.disease_name(c)
            if n and n not in names:
                names.append(n)
            if len(names) >= MAX_CANDIDATES:
                break
        return "、".join(names)


class KinkiDiseaseRule(Rule):
    rule_id = "IY-003"
    name = "禁忌傷病名への投与"
    category = "医薬品適応"
    description = "医薬品の禁忌にあたる傷病名が記録されている患者への投与を検出(支払基金チェックマスタ)"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        diseases = disease_codes_of(receipt)
        if not diseases:
            return out
        reported: set = set()
        for it in receipt.drugs:
            if not it.code or it.code in reported:
                continue
            reported.add(it.code)
            kinki = set(official.drug_kinki_diseases(it.code))
            hit = kinki & diseases
            for code in sorted(hit):
                dname = ctx.masters.disease_name(code) or code
                out.append(
                    self.make_finding(
                        receipt,
                        f"医薬品「{it.display_name}」の禁忌傷病名「{dname}」が記録されています",
                        target=it.display_name,
                        detail="支払基金チェックマスタ(添付文書ベース)の禁忌傷病名に該当します。",
                        suggestion="投与の可否を確認してください。医学的必要性がある場合は症状詳記での説明が必要です。",
                    )
                )
        return out


RULES = [DrugIndicationRule(), KinkiDiseaseRule()]
FILE_RULES = []
