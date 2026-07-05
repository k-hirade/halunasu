"""R13: 病名整理(不要病名の抽出)

当月の診療行為・医薬品のいずれの適応にも該当しない傷病名を抽出する。
市販ソフトの「不要病名抽出」「病名整理点検」に相当し、
レセプト病名の蓄積を防ぎ、傷病名欄の整理を支援する。

判定はあくまで「当月の請求内容から見て使われていない」ことの検出であり、
経過観察中の疾患等は不要とは限らないため、重大度はINFO(参考)とする。
"""

from __future__ import annotations

from ..models import Receipt, Severity, months_between
from .base import CheckContext, Rule


class UnusedDiseaseRule(Rule):
    rule_id = "SEI-001"
    name = "不要病名の可能性(病名整理)"
    category = "病名整理"
    description = "前月以前から継続し、当月の診療行為・医薬品のいずれの適応にも該当しない傷病名を抽出(レセプト病名の整理支援。当月開始の傷病名は対象外)"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official or not receipt.items:
            return out

        # 当月の全項目が適応として参照する傷病名コードの集合を作る
        referenced: set = set()
        has_indication_data = False
        for it in receipt.items:
            if not it.code:
                continue
            if it.rec_type == "IY":
                rows = official.drug_indications(it.code)
                if rows:
                    has_indication_data = True
                    referenced.update(r[0] for r in rows)
                ind = ctx.masters.drug_indications.get(it.code)
                if ind:
                    has_indication_data = True
                    referenced.update(ind.disease_codes)
            elif it.rec_type == "SI":
                rows = official.act_indications(it.code)
                if rows:
                    has_indication_data = True
                    referenced.update(r[0] for r in rows)
                ind = ctx.masters.act_indications.get(it.code)
                if ind:
                    has_indication_data = True
                    referenced.update(ind.disease_codes)

        # 適応データを持つ項目がひとつもなければ判断材料がない
        if not has_indication_data:
            return out

        shinryo = receipt.shinryo_ym_as_date()
        unused = []
        for d in receipt.active_diseases:
            if not d.code or d.is_uncoded:
                continue
            if d.code in referenced:
                continue
            months = None
            start = d.start_date_as_date()
            if start and shinryo:
                months = months_between(start, shinryo)
            # 当月開始の傷病名(まさに当月受診の理由)は整理候補にしない
            if months is not None and months <= 0:
                continue
            unused.append((d, months))

        if not unused:
            return out
        # レセプト単位で1件にまとめる(病名ごとの多発を避ける)
        names = []
        for d, months in unused:
            label = d.display_name
            if months is not None and months >= 6:
                label += f"({months}か月継続)"
            if d.is_main:
                label += "【主傷病】"
            names.append(label)
        out.append(
            self.make_finding(
                receipt,
                f"当月の診療内容と対応しない傷病名が{len(unused)}件あります: {'、'.join(names[:8])}"
                + ("…" if len(names) > 8 else ""),
                target="病名整理",
                detail="当月に算定された診療行為・医薬品の適応データ(支払基金チェックマスタ+施設ルール)のいずれからも参照されていない継続傷病名です。適応データが登録されていない項目の対象病名は検出できないため、参考情報として確認してください。",
                suggestion="治癒・中止済みであれば転帰を記録して整理してください。傷病名の多いレセプトは「レセプト病名」を疑われ、審査で重点確認の対象になります。",
            )
        )
        return out


RULES = [UnusedDiseaseRule()]
FILE_RULES = []
