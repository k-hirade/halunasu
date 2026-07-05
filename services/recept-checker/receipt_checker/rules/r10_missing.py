"""R10: 算定もれチェック(逆チェック)

「この診療行為・医薬品・傷病名があるなら、この項目が算定できるはず」
という増収側の点検。

1. 検体検査の判断料もれ(医科診療行為マスターの検査等実施判断区分・グループ)
2. 基本診療料(初診料・再診料・外来診療料)のないレセプト
3. 院内処方(投薬)があるのに処方料・処方箋料がない
4. 施設ルール masters/data/missing_patterns.csv によるパターン検出
"""

from __future__ import annotations

from ..codes import TOYAKU_SHIKIBETSU
from ..models import Receipt, Severity
from .base import CheckContext, Rule

_SEVERITY_MAP = {
    "error": Severity.ERROR,
    "warning": Severity.WARNING,
    "info": Severity.INFO,
}

KENSA_GROUP_NAMES = {
    "1": "尿・糞便等検査判断料",
    "2": "血液学的検査判断料",
    "3": "生化学的検査(I)判断料",
    "4": "生化学的検査(II)判断料",
    "5": "免疫学的検査判断料",
    "6": "微生物学的検査判断料",
    "17": "遺伝子関連・染色体検査判断料",
}

# 尿一般(D000 尿中一般物質定性半定量検査): これのみの場合、尿・糞便等検査判断料は算定不可
D000_URINE_CODE = "160000310"


class KensaHanteiRyoRule(Rule):
    rule_id = "MI-002"
    name = "検体検査判断料の算定もれ"
    category = "算定もれ"
    description = "検体検査を実施しているのに対応する検査判断料(月1回)が算定されていないケースを検出"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out

        # 実施した検査のグループと、算定済み判断料のグループを収集
        performed_groups: dict = {}   # group -> [検査名]
        billed_hantei_groups: set = set()
        d000_only_candidate: dict = {}  # group1 の D000 のみ判定用

        for it in receipt.acts:
            if not it.code:
                continue
            m = official.act(it.code)
            if not m:
                continue
            hantei = (m.get("kensa_hantei") or "").strip()
            group = (m.get("kensa_group") or "").strip().lstrip("0")
            if hantei == "1" and group:
                performed_groups.setdefault(group, []).append(it.display_name)
                if group == "1":
                    d000_only_candidate.setdefault("codes", set()).add(it.code)
            elif hantei == "2" and group:
                billed_hantei_groups.add(group)

        for group, names in performed_groups.items():
            if group in billed_hantei_groups:
                continue
            if group not in KENSA_GROUP_NAMES:
                continue
            # 例外: D000(尿中一般物質定性半定量検査)のみの場合、判断料は算定不可
            if group == "1":
                codes = d000_only_candidate.get("codes", set())
                if codes and codes <= {D000_URINE_CODE}:
                    continue
            hantei_name = KENSA_GROUP_NAMES[group]
            out.append(
                self.make_finding(
                    receipt,
                    f"{hantei_name}の算定もれの可能性があります",
                    target=hantei_name,
                    detail=f"実施済みの検査: {'、'.join(names[:5])}",
                    suggestion="検体検査判断料は区分ごとに月1回算定できます。算定要件を満たしていれば算定してください(算定もれは収益の損失です)。※生活習慣病管理料(I)算定患者は検査が包括されるため算定不可。",
                )
            )
        return out


class NoBaseVisitFeeRule(Rule):
    rule_id = "MI-003"
    name = "基本診療料のないレセプト"
    category = "算定もれ"
    description = "外来レセプトに初診料・再診料・外来診療料のいずれもないケースを検出"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        if receipt.is_inpatient or not receipt.items:
            return []
        official = ctx.masters.official
        has_base = False
        for it in receipt.acts:
            if it.shinryo_shikibetsu in ("11", "12"):
                has_base = True
                break
            if official:
                m = official.act(it.code)
                if m and (m.get("kubun") or "") in ("A000", "A001", "A002"):
                    has_base = True
                    break
        if not has_base:
            return [
                self.make_finding(
                    receipt,
                    "初診料・再診料・外来診療料のいずれも算定されていません",
                    suggestion="基本診療料の記録漏れがないか確認してください(電話再診等の算定漏れの可能性もあります)。",
                )
            ]
        return []


class NoPrescriptionFeeRule(Rule):
    rule_id = "MI-004"
    name = "処方料・処方箋料の算定もれ"
    category = "算定もれ"
    description = "投薬(内服・屯服・外用)があるのに処方料(F100)・処方箋料(F400)がないケースを検出"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        if receipt.is_inpatient:
            return []  # 入院は処方料の概念が異なる
        official = ctx.masters.official
        if not official:
            return []
        has_toyaku = any(
            it.rec_type == "IY" and it.shinryo_shikibetsu in ("21", "22", "23")
            for it in receipt.items
        )
        if not has_toyaku:
            return []
        for it in receipt.acts:
            m = official.act(it.code)
            if m and (m.get("kubun") or "") in ("F100", "F400"):
                return []
        return [
            self.make_finding(
                receipt,
                "投薬があるのに処方料・処方箋料が算定されていません",
                suggestion="院内処方であれば処方料(F100)、院外処方であれば処方箋料(F400)の算定漏れがないか確認してください。",
            )
        ]


class MissingBillingRule(Rule):
    rule_id = "MI-001"
    name = "算定もれの可能性(施設ルール)"
    category = "算定もれ"
    description = "施設ルールCSVに基づき、実施内容から算定できるはずの項目の算定もれを検出(増収チェック)"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        act_codes = {it.code for it in receipt.acts}
        drug_codes = {it.code for it in receipt.drugs}
        disease_codes = {d.code for d in receipt.diseases}
        disease_names = [d.display_name for d in receipt.diseases]
        all_item_codes = act_codes | drug_codes

        for p in ctx.masters.missing_patterns:
            triggered = False
            trigger_desc = ""
            if p.trigger_type == "act":
                hit = p.trigger_codes & act_codes
                if hit:
                    triggered = True
                    trigger_desc = self._names(ctx, hit, "act")
            elif p.trigger_type == "drug":
                hit = p.trigger_codes & drug_codes
                if hit:
                    triggered = True
                    trigger_desc = self._names(ctx, hit, "drug")
            elif p.trigger_type == "drug_category":
                hits = [
                    it.display_name for it in receipt.drugs
                    if any(kw in it.display_name for kw in p.trigger_keywords)
                ]
                if hits:
                    triggered = True
                    trigger_desc = "、".join(hits[:3])
            elif p.trigger_type == "disease":
                hit = p.trigger_codes & disease_codes
                kw_hit = [
                    n for n in disease_names
                    if any(kw in n for kw in p.trigger_keywords)
                ]
                if hit or kw_hit:
                    triggered = True
                    trigger_desc = self._disease_names(ctx, hit) or "、".join(kw_hit[:3])

            if not triggered:
                continue
            if p.expected_codes & all_item_codes:
                continue
            out.append(
                self.make_finding(
                    receipt,
                    p.message or f"「{p.expected_name}」の算定もれの可能性があります",
                    severity=_SEVERITY_MAP.get(p.severity, Severity.INFO),
                    target=p.expected_name,
                    detail=f"トリガー: {trigger_desc}" if trigger_desc else "",
                    suggestion="算定要件を満たしている場合は算定を検討してください(算定もれは病院収益の損失になります)。",
                )
            )
        return out

    @staticmethod
    def _names(ctx: CheckContext, codes: set, kind: str) -> str:
        names = []
        for c in sorted(codes):
            n = ctx.masters.act_name(c) if kind == "act" else ctx.masters.drug_name(c)
            names.append(n or c)
        return "、".join(names[:3])

    @staticmethod
    def _disease_names(ctx: CheckContext, codes: set) -> str:
        return "、".join(
            (ctx.masters.disease_name(c) or c) for c in sorted(codes)[:3]
        )


RULES = [KensaHanteiRyoRule(), NoBaseVisitFeeRule(), NoPrescriptionFeeRule(), MissingBillingRule()]
FILE_RULES = []
