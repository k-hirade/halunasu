"""R05: 診療行為の適応チェック(検査・処置・手術 ⇔ 傷病名)

実施された検査・処置・手術・医学管理料等に対応する傷病名が
レセプトに記録されているかを点検する。

データソース(優先順):
1. 支払基金チェックマスタ「医科診療行為傷病名関連マスタ」
   (性別・年齢・入外・疑い病名可否の条件付き、21万行超) — masters.db
2. 施設ルール masters/data/act_indications.csv
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule
from .helpers import age_matches, patient_age_years, sex_matches

MAX_CANDIDATES = 5


class ActIndicationRule(Rule):
    rule_id = "SI-001"
    name = "診療行為の適応病名なし"
    category = "診療行為適応"
    description = "検査・処置・手術・医学管理料等に対応する傷病名がレセプトにあるか点検(支払基金チェックマスタ+施設ルール)"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        age = patient_age_years(receipt)
        confirmed = {d.code for d in receipt.diseases if d.code and not d.is_uncoded and not d.is_suspected}
        suspected = {d.code for d in receipt.diseases if d.code and not d.is_uncoded and d.is_suspected}
        reported: set = set()

        for it in receipt.acts:
            if not it.code or it.code in reported:
                continue
            reported.add(it.code)

            rows = official.act_indications(it.code) if official else ()
            if rows:
                out.extend(self._check_official(receipt, ctx, it, rows, age, confirmed, suspected))
                continue

            ind = ctx.masters.act_indications.get(it.code)
            if ind is None:
                continue
            matched = False
            for d in receipt.diseases:
                if d.code and d.code in ind.disease_codes:
                    matched = True
                    break
                if any(kw and kw in d.display_name for kw in ind.disease_keywords):
                    matched = True
                    break
            if not matched:
                expected = "、".join(ind.disease_keywords[:MAX_CANDIDATES]) or "対応する傷病名"
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{it.display_name}」に対応する傷病名が見当たりません(施設ルール)",
                        target=it.display_name,
                        detail=f"想定される傷病名の例: {expected}(検査は疑い病名でも可)",
                        suggestion="実施理由となる傷病名を記録してください。病名のない検査・処置は査定事由C(不必要)の対象です。",
                    )
                )
        return out

    def _check_official(self, receipt, ctx, it, rows, age, confirmed, suspected) -> list:
        """支払基金チェックマスタによる適応判定

        行の条件: (disease_code, sex, age_min, age_max, nyugai, utagai)
          nyugai 0:両方 1:入院のみ 2:入院外のみ
          utagai 0:確定+疑い可 1:確定のみ 2:疑いのみ
        """
        nyuin = receipt.is_inpatient
        applicable = []
        for r in rows:
            disease_code, sex, age_min, age_max, nyugai, utagai = r
            if not sex_matches(sex, receipt.sex):
                continue
            if not age_matches(age_min, age_max, age):
                continue
            if nyugai == "1" and not nyuin:
                continue
            if nyugai == "2" and nyuin:
                continue
            applicable.append((disease_code, utagai))
        if not applicable:
            return [
                self.make_finding(
                    receipt,
                    f"「{it.display_name}」は患者の条件(性別・年齢・入外)に該当する適応がありません",
                    target=it.display_name,
                    detail=f"患者: {receipt.sex_label}・{receipt.age}歳・{'入院' if nyuin else '入院外'}",
                    suggestion="算定対象(性別・年齢・入院/外来)を確認してください。",
                )
            ]

        for disease_code, utagai in applicable:
            if utagai in ("0", "", "1") and disease_code in confirmed:
                return []
            if utagai in ("0", "") and disease_code in suspected:
                return []
            if utagai == "2" and disease_code in suspected:
                return []
            if utagai == "1" and disease_code in suspected:
                continue  # 確定のみ可の行に疑いしかない → 不一致として続行

        # 疑い病名でしか合致しなかった「確定のみ」行があるかを判定
        only_suspected_for_confirmed = any(
            u == "1" and dc in suspected for dc, u in applicable
        )
        if only_suspected_for_confirmed:
            return [
                self.make_finding(
                    receipt,
                    f"「{it.display_name}」の適応病名が「疑い」病名しかありません(確定病名が必要な項目)",
                    target=it.display_name,
                    suggestion="この項目は確定病名に対して算定します。確定病名の記録を検討してください。",
                )
            ]

        candidates = self._candidate_names(ctx, sorted({dc for dc, _ in applicable}))
        return [
            self.make_finding(
                receipt,
                f"「{it.display_name}」に対応する適応傷病名が記録されていません",
                target=it.display_name,
                detail=f"適応病名の候補例: {candidates}(検査は疑い病名でも可)" if candidates else "",
                suggestion="実施理由となる傷病名を記録してください。病名のない検査・処置は査定事由C(不必要)の対象です。",
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


RULES = [ActIndicationRule()]
FILE_RULES = []
