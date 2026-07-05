"""R08: 併算定不可(背反)・包括・加算チェック

同時に算定できない診療行為の組み合わせ、包括関係(含まれるため
別に算定できない)、親項目なしの加算算定を点検する。

データソース(優先順):
1. 医科電子点数表「背反関連テーブル」(1日につき/同一月内/同時/1週間につき の4条件)
2. 医科電子点数表「包括・被包括テーブル」(包括単位: 1日/同一月/同時 等)
3. 医科診療行為マスターの注加算コード・通番(加算と基本項目の対応)
4. 施設ルール masters/data/exclusive_pairs.csv

代表例: 外来管理加算と処置・手術、特定疾患療養管理料と他の医学管理料、
初診料と同月の特定疾患療養管理料(包括)など。
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule
from .helpers import days_of_code, week_of_day

SPAN_LABEL = {
    "day": "同一日に",
    "month": "同一月に",
    "simul": "同時に",
    "week": "同一週に",
}

HOKATSU_UNIT_LABEL = {
    "1": "1日につき",
    "01": "1日につき",
    "2": "同一月内",
    "02": "同一月内",
    "3": "同時",
    "03": "同時",
    "5": "手術前1週間",
    "05": "手術前1週間",
    "6": "1手術につき",
    "06": "1手術につき",
}


def _codes_conflict_in_span(receipt: Receipt, code_a: str, code_b: str, span: str):
    """2コードが指定条件(span)内で重なって算定されているか。

    戻り値: (重なりあり: bool, 詳細文字列)
    算定日情報がない場合は同月内の同時存在をもって「重なりの可能性あり」とする。
    """
    days_a = days_of_code(receipt, code_a)
    days_b = days_of_code(receipt, code_b)

    if span == "month":
        return True, ""

    if not days_a or not days_b:
        # 日情報が欠けている場合、日・週・同時条件は「可能性あり」で報告
        return True, "(算定日情報がないため日単位の判定はできません)"

    if span in ("day", "simul"):
        overlap = days_a & days_b
        if overlap:
            label = "、".join(f"{d}日" for d in sorted(overlap))
            return True, f"(重複日: {label})"
        return False, ""

    if span == "week":
        weeks_a = {week_of_day(receipt, d) for d in days_a} - {None}
        weeks_b = {week_of_day(receipt, d) for d in days_b} - {None}
        if weeks_a & weeks_b:
            return True, "(同一週内に算定)"
        return False, ""

    return True, ""


class OfficialHaihanRule(Rule):
    rule_id = "EX-001"
    name = "併算定不可(背反)の組み合わせ"
    category = "併算定(背反)"
    description = "電子点数表の背反テーブル(1日/同月/同時/1週間)に基づき併算定不可の組み合わせを検出"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        codes = sorted({it.code for it in receipt.acts if it.code})
        if len(codes) < 2:
            return out

        reported: set = set()
        for span in ("day", "month", "simul", "week"):
            for code_a, code_b, kubun, name_a, name_b, tokurei in official.haihan_pairs(codes, span):
                key = tuple(sorted((code_a, code_b)))
                if key in reported:
                    continue
                conflict, note = _codes_conflict_in_span(receipt, code_a, code_b, span)
                if not conflict:
                    continue
                reported.add(key)
                na = name_a or ctx.masters.act_name(code_a) or code_a
                nb = name_b or ctx.masters.act_name(code_b) or code_b
                if kubun == "1":
                    keep = f"「{na}」を算定し「{nb}」は算定できません"
                elif kubun == "2":
                    keep = f"「{nb}」を算定し「{na}」は算定できません"
                else:
                    keep = "いずれか一方のみ算定できます"
                sev = Severity.WARNING if tokurei == "1" else Severity.ERROR
                tokurei_note = "※告示・通知に特例条件があります。該当するか確認してください。" if tokurei == "1" else ""
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{na}」と「{nb}」が{SPAN_LABEL[span]}算定されています{note}",
                        severity=sev,
                        target=f"{na} × {nb}",
                        detail=f"電子点数表・背反テーブル({SPAN_LABEL[span]}算定不可)。{keep}。{tokurei_note}",
                        suggestion="算定要件を確認し、いずれか(点数表の規定に従い主たるもの)のみ算定してください。",
                    )
                )
        return out


class OfficialHokatsuRule(Rule):
    rule_id = "EX-003"
    name = "包括項目の併算定"
    category = "併算定(背反)"
    description = "電子点数表の包括テーブルに基づき「他の項目に含まれるため算定不可」の組み合わせを検出"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        act_codes = {it.code for it in receipt.acts if it.code}
        if len(act_codes) < 2:
            return out

        reported: set = set()
        for parent_code in sorted(act_codes):
            hojo = official.hojo(parent_code)
            if not hojo:
                continue
            for unit_key, group_key in (("h_unit1", "h_group1"), ("h_unit2", "h_group2"), ("h_unit3", "h_group3")):
                unit = (hojo.get(unit_key) or "").strip()
                group = (hojo.get(group_key) or "").strip()
                if not group or group == "0" or unit in ("", "0", "00"):
                    continue
                span = {"1": "day", "01": "day", "2": "month", "02": "month", "3": "simul", "03": "simul"}.get(unit)
                if span is None:
                    continue  # 手術前1週間・1手術につき等は対象外(個別判断が必要)
                for child_code, child_name, _tokurei in official.hokatsu_children(group):
                    if child_code not in act_codes or child_code == parent_code:
                        continue
                    key = (parent_code, child_code)
                    if key in reported:
                        continue
                    conflict, note = _codes_conflict_in_span(receipt, parent_code, child_code, span)
                    if not conflict:
                        continue
                    reported.add(key)
                    pname = ctx.masters.act_name(parent_code) or parent_code
                    cname = child_name or ctx.masters.act_name(child_code) or child_code
                    out.append(
                        self.make_finding(
                            receipt,
                            f"「{cname}」は「{pname}」に包括されるため{HOKATSU_UNIT_LABEL.get(unit, '')}は別に算定できません{note}",
                            target=f"{pname} ⊃ {cname}",
                            detail="電子点数表・包括/被包括テーブルに基づく判定です。",
                            suggestion="包括される側の項目は算定から除外してください。",
                        )
                    )
        return out


class AddOnWithoutParentRule(Rule):
    rule_id = "EX-002"
    name = "加算の単独算定"
    category = "併算定(背反)"
    description = "基本項目なしで注加算のみが算定されていないか点検(診療行為マスターの注加算コード・通番)"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        act_codes = {it.code for it in receipt.acts if it.code}

        if official:
            # 注加算コードごとに基本項目(通番0)と加算項目(通番!=0)を仕分け
            groups: dict = {}
            for it in receipt.acts:
                if not it.code:
                    continue
                m = official.act(it.code)
                if not m:
                    continue
                gcode = (m.get("chukasan_code") or "").strip()
                if not gcode or gcode == "0":
                    continue
                ban = (m.get("chukasan_ban") or "").strip()
                g = groups.setdefault(gcode, {"base": set(), "addons": []})
                if ban in ("0", ""):
                    g["base"].add(it.code)
                else:
                    g["addons"].append(it)

            for gcode, g in groups.items():
                if not g["addons"]:
                    continue
                if not g["base"]:
                    # 同グループの基本項目がレセプト内に1つもない
                    for it in g["addons"]:
                        days_addon = days_of_code(receipt, it.code)
                        out.append(
                            self.make_finding(
                                receipt,
                                f"加算「{it.display_name}」が算定されていますが、対応する基本項目の算定がありません",
                                target=it.display_name,
                                detail=f"注加算グループ({gcode})内の基本項目が見当たりません。"
                                       + (f" 加算の算定日: {'、'.join(str(d) for d in sorted(days_addon))}日" if days_addon else ""),
                                suggestion="加算は基本項目と同時にのみ算定できます。基本項目の記録漏れか、加算の誤算定です。",
                            )
                        )
                    continue
                # 基本項目はあるが、加算の算定日に基本項目の算定がない日を検出
                base_days: set = set()
                for bcode in g["base"]:
                    base_days |= days_of_code(receipt, bcode)
                if not base_days:
                    continue  # 基本項目に日情報がなければ月内存在で良しとする
                for it in g["addons"]:
                    addon_days = days_of_code(receipt, it.code)
                    missing = addon_days - base_days
                    if missing:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"加算「{it.display_name}」の算定日({'、'.join(str(d) for d in sorted(missing))}日)に、対応する基本項目の算定がありません",
                                target=it.display_name,
                                detail=f"注加算グループ({gcode})。加算は基本項目と同日にのみ算定できます。",
                                suggestion="基本項目の算定日と加算の算定日を確認してください。",
                            )
                        )
            return out

        # 公的マスターなし: 施設ルール(category="加算:親コード|親コード")で判定
        for it in receipt.acts:
            m = ctx.masters.shinryo_koi.get(it.code)
            if not m or not m.category.startswith("加算:"):
                continue
            parents = set(m.category[len("加算:"):].split("|"))
            if parents and not (parents & act_codes):
                parent_names = "、".join(ctx.masters.act_name(p) or p for p in sorted(parents))
                out.append(
                    self.make_finding(
                        receipt,
                        f"加算「{it.display_name}」が算定されていますが、基本となる項目({parent_names})の算定がありません",
                        target=it.display_name,
                        suggestion="加算は基本項目と同時にのみ算定できます。",
                    )
                )
        return out


class LocalExclusivePairRule(Rule):
    rule_id = "EX-004"
    name = "併算定不可の組み合わせ(施設ルール)"
    category = "併算定(背反)"
    description = "施設ルールCSVで定義した併算定不可の組み合わせを検出"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        by_code: dict = {}
        for it in receipt.acts:
            by_code.setdefault(it.code, []).append(it)

        seen: set = set()
        for pair in ctx.masters.exclusive_pairs:
            if not (by_code.get(pair.code_a) and by_code.get(pair.code_b)):
                continue
            key = tuple(sorted((pair.code_a, pair.code_b)))
            if key in seen:
                continue
            span = "day" if pair.span == "same_day" else "month"
            conflict, note = _codes_conflict_in_span(receipt, pair.code_a, pair.code_b, span)
            if not conflict:
                continue
            seen.add(key)
            name_a = pair.name_a or ctx.masters.act_name(pair.code_a) or pair.code_a
            name_b = pair.name_b or ctx.masters.act_name(pair.code_b) or pair.code_b
            out.append(
                self.make_finding(
                    receipt,
                    f"「{name_a}」と「{name_b}」が{SPAN_LABEL[span]}算定されています{note}",
                    target=f"{name_a} × {name_b}",
                    detail=(pair.reason or "") + (f"【根拠: {pair.source}】" if pair.source else ""),
                    suggestion="いずれか一方のみ算定可能です。算定要件を確認してください。",
                )
            )
        return out


RULES = [
    OfficialHaihanRule(),
    OfficialHokatsuRule(),
    AddOnWithoutParentRule(),
    LocalExclusivePairRule(),
]
FILE_RULES = []
